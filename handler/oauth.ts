import { createHash } from 'crypto';
import {
    Handler, PRIV, Types, param, query, NotFoundError, ValidationError,
    Context, UserModel, SystemModel,
} from 'hydrooj';
import { oi33Model } from '../model';
import { DEFAULT_SCOPES } from '../model/oauth';

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyPkce(codeVerifier: string, codeChallenge: string, method: 'S256' | 'plain' | undefined): boolean {
    if (!method || method === 'plain') return codeVerifier === codeChallenge;
    if (method === 'S256') {
        const hash = createHash('sha256').update(codeVerifier).digest();
        return base64url(hash) === codeChallenge;
    }
    return false;
}

function appendErrorToRedirect(redirectUri: string, error: string, state?: string, description?: string): string {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (description) u.searchParams.set('error_description', description);
    if (state) u.searchParams.set('state', state);
    return u.toString();
}

function extractClientCreds(handler: Handler): { clientId?: string; clientSecret?: string } {
    const auth = handler.request.headers.authorization;
    if (auth && auth.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
            const idx = decoded.indexOf(':');
            if (idx !== -1) {
                return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
            }
        } catch { /* ignore malformed */ }
    }
    const body = (handler.request.body || {}) as Record<string, any>;
    return { clientId: body.client_id, clientSecret: body.client_secret };
}

// JSON error helper for OAuth API endpoints (token/userinfo/revoke).
function oauthJsonError(handler: Handler, status: number, error: string, description: string) {
    handler.response.status = status;
    handler.response.template = undefined;
    handler.response.type = 'application/json';
    handler.response.body = { error, error_description: description };
}

// =========================================================================
// Authorization endpoint — GET shows consent, POST approves/denies
// =========================================================================

class OAuthAuthorizeHandler extends Handler {
    noCheckPermView = true;

    @query('response_type', Types.String, true)
    @query('client_id', Types.String, true)
    @query('redirect_uri', Types.String, true)
    @query('state', Types.String, true)
    @query('code_challenge', Types.String, true)
    @query('code_challenge_method', Types.String, true)
    async get(
        domainId: string,
        response_type = '', client_id = '', redirect_uri = '',
        state = '', code_challenge = '', code_challenge_method = '',
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const client = client_id ? await oi33Model.getClient(client_id) : null;
        // For security, if client/redirect invalid we MUST NOT redirect to redirect_uri.
        if (!client) {
            this.response.template = 'oi33_oauth_error.html';
            this.response.body = { error: 'invalid_client', message: 'Unknown or inactive client.' };
            return;
        }
        if (!redirect_uri || !oi33Model.redirectAllowed(client, redirect_uri)) {
            this.response.template = 'oi33_oauth_error.html';
            this.response.body = { error: 'invalid_request', message: 'redirect_uri does not match registered URIs.' };
            return;
        }
        if (response_type !== 'code') {
            this.response.redirect = appendErrorToRedirect(redirect_uri, 'unsupported_response_type', state);
            return;
        }
        if (code_challenge_method && code_challenge_method !== 'S256' && code_challenge_method !== 'plain') {
            this.response.redirect = appendErrorToRedirect(redirect_uri, 'invalid_request', state, 'Unsupported code_challenge_method');
            return;
        }
        this.response.template = 'oi33_oauth_authorize.html';
        this.response.body = {
            client,
            response_type, client_id, redirect_uri, state,
            code_challenge, code_challenge_method,
            csrfToken: (this as any).csrfToken || '',
        };
    }

    @param('decision', Types.String)
    @param('client_id', Types.String)
    @param('redirect_uri', Types.String)
    @param('state', Types.String, true)
    @param('code_challenge', Types.String, true)
    @param('code_challenge_method', Types.String, true)
    async post(
        domainId: string, decision: string,
        client_id: string, redirect_uri: string, state = '',
        code_challenge = '', code_challenge_method = '',
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const client = await oi33Model.getClient(client_id);
        if (!client || !oi33Model.redirectAllowed(client, redirect_uri)) {
            this.response.template = 'oi33_oauth_error.html';
            this.response.body = { error: 'invalid_client', message: 'Unknown client or mismatched redirect_uri.' };
            return;
        }
        if (decision === 'deny') {
            await oi33Model.logDeny(client_id, this.user._id);
            this.response.redirect = appendErrorToRedirect(redirect_uri, 'access_denied', state, 'The user denied the request');
            return;
        }
        const challengeMethod = (code_challenge_method as 'S256' | 'plain' | undefined) || undefined;
        const code = await oi33Model.createCode(
            client, this.user._id, redirect_uri, DEFAULT_SCOPES,
            code_challenge || undefined, challengeMethod,
        );
        const u = new URL(redirect_uri);
        u.searchParams.set('code', code);
        if (state) u.searchParams.set('state', state);
        this.response.redirect = u.toString();
    }
}

// =========================================================================
// Base for JSON API endpoints — overrides onerror to return JSON
// =========================================================================

abstract class OAuthApiHandler extends Handler {
    noCheckPermView = true;
    allowCors = true;

    async onerror(error: any) {
        const status = (typeof error?.code === 'number') ? error.code : 500;
        if (status >= 500) console.error('[oi33/oauth] server error:', error);
        const msg = (typeof error?.msg === 'function') ? error.msg() : (error?.message || 'Internal error');
        oauthJsonError(this, status, 'server_error', msg);
    }

    protected bearerToken(): string | null {
        const auth = this.request.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) return null;
        return auth.slice(7).trim();
    }
}

// =========================================================================
// Token endpoint — authorization_code & refresh_token grants
// =========================================================================

class OAuthTokenHandler extends OAuthApiHandler {
    async post() {
        const body = (this.request.body || {}) as Record<string, any>;
        const grantType = body.grant_type;
        if (grantType === 'authorization_code') {
            await this.handleAuthorizationCode(body);
        } else if (grantType === 'refresh_token') {
            await this.handleRefreshToken(body);
        } else {
            oauthJsonError(this, 400, 'unsupported_grant_type', `grant_type must be authorization_code or refresh_token`);
        }
    }

    private async authenticateClient(clientId: string, clientSecret?: string) {
        const client = clientId ? await oi33Model.getClient(clientId) : null;
        if (!client) return null;
        if (!client.isPublic) {
            if (!clientSecret || !oi33Model.verifyClientSecret(client, clientSecret)) return null;
        }
        return client;
    }

    private async handleAuthorizationCode(body: Record<string, any>) {
        const { clientId, clientSecret } = extractClientCreds(this);
        const client = await this.authenticateClient(body.client_id || clientId, body.client_secret || clientSecret);
        if (!client) {
            oauthJsonError(this, 401, 'invalid_client', 'Client authentication failed');
            return;
        }
        const codeDoc = body.code ? await oi33Model.consumeCode(body.code) : null;
        if (!codeDoc) {
            oauthJsonError(this, 400, 'invalid_grant', 'Authorization code is invalid, expired, or already used');
            return;
        }
        if (codeDoc.clientId !== client._id) {
            oauthJsonError(this, 400, 'invalid_grant', 'Code was issued to a different client');
            return;
        }
        if (codeDoc.redirectUri !== body.redirect_uri) {
            oauthJsonError(this, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
            return;
        }
        if (codeDoc.codeChallenge) {
            if (!body.code_verifier) {
                oauthJsonError(this, 400, 'invalid_grant', 'code_verifier is required (PKCE)');
                return;
            }
            if (!verifyPkce(body.code_verifier, codeDoc.codeChallenge, codeDoc.codeChallengeMethod)) {
                oauthJsonError(this, 400, 'invalid_grant', 'PKCE verification failed');
                return;
            }
        }
        const issued = await oi33Model.createAccessToken(client, codeDoc.uid, codeDoc.scopes);
        this.response.type = 'application/json';
        this.response.body = {
            access_token: issued.accessToken,
            token_type: 'Bearer',
            expires_in: client.accessTokenTtl,
            refresh_token: issued.refreshToken,
            scope: codeDoc.scopes.join(' '),
        };
    }

    private async handleRefreshToken(body: Record<string, any>) {
        const { clientId, clientSecret } = extractClientCreds(this);
        const client = await this.authenticateClient(body.client_id || clientId, body.client_secret || clientSecret);
        if (!client) {
            oauthJsonError(this, 401, 'invalid_client', 'Client authentication failed');
            return;
        }
        if (!body.refresh_token) {
            oauthJsonError(this, 400, 'invalid_request', 'refresh_token is required');
            return;
        }
        const refreshed = await oi33Model.refreshAccessToken(body.refresh_token);
        if (!refreshed) {
            oauthJsonError(this, 400, 'invalid_grant', 'Refresh token is invalid or expired');
            return;
        }
        if (refreshed.client._id !== client._id) {
            oauthJsonError(this, 400, 'invalid_grant', 'Refresh token was issued to a different client');
            return;
        }
        this.response.type = 'application/json';
        this.response.body = {
            access_token: refreshed.accessToken,
            token_type: 'Bearer',
            expires_in: refreshed.client.accessTokenTtl,
            scope: refreshed.scopes.join(' '),
        };
    }
}

// =========================================================================
// UserInfo endpoint — Bearer access token → user profile
// =========================================================================

class OAuthUserInfoHandler extends OAuthApiHandler {
    async get() {
        const raw = this.bearerToken();
        if (!raw) {
            oauthJsonError(this, 401, 'invalid_token', 'Missing Bearer access token');
            return;
        }
        const tdoc = await oi33Model.getAccessTokenByRaw(raw);
        if (!tdoc) {
            oauthJsonError(this, 401, 'invalid_token', 'Access token is invalid or expired');
            return;
        }
        const udoc = await UserModel.getById('system', tdoc.uid);
        if (!udoc) {
            oauthJsonError(this, 401, 'invalid_token', 'User not found');
            return;
        }
        this.response.type = 'application/json';
        this.response.body = { sub: String(tdoc.uid), uname: udoc.uname };
    }
}

// =========================================================================
// Token revocation endpoint (RFC 7009)
// =========================================================================

class OAuthRevokeHandler extends OAuthApiHandler {
    async post() {
        const body = (this.request.body || {}) as Record<string, any>;
        const token = body.token;
        if (token) await oi33Model.revokeToken(token);
        this.response.status = 200;
        this.response.type = 'application/json';
        this.response.body = {};
    }
}

// =========================================================================
// Client management (admin only)
// =========================================================================

class OAuthClientsHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const clients = await oi33Model.getClients();
        this.response.template = 'oi33_oauth_clients.html';
        this.response.body = { clients, newClient: null, rawSecret: null };
    }
}

class OAuthClientCreateHandler extends Handler {
    @param('name', Types.String)
    @param('redirectUris', Types.String)
    @param('isPublic', Types.String, true)
    @param('description', Types.String, true)
    @param('accessTokenTtl', Types.Int, true)
    @param('refreshTokenTtl', Types.Int, true)
    async post(
        domainId: string, name: string, redirectUris: string,
        isPublic = 'false', description = '',
        accessTokenTtl = 0, refreshTokenTtl = 0,
    ) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        if (!name || !redirectUris) throw new ValidationError('name');
        const uriList = redirectUris.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (!uriList.length) throw new ValidationError('redirectUris');
        for (const u of uriList) {
            try { new URL(u); } catch { throw new ValidationError('redirectUris'); }
        }
        const { client, rawSecret } = await oi33Model.createClient(
            name, uriList, DEFAULT_SCOPES, this.user._id, isPublic === 'true',
            description, accessTokenTtl || undefined, refreshTokenTtl || undefined,
        );
        const clients = await oi33Model.getClients();
        this.response.template = 'oi33_oauth_clients.html';
        this.response.body = { clients, newClient: client, rawSecret };
    }
}

class OAuthClientDeleteHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const ok = await oi33Model.deleteClient(id);
        if (!ok) throw new NotFoundError(id);
        this.response.redirect = this.url('oi33_oauth_clients');
    }
}

class OAuthClientShowHandler extends Handler {
    @param('id', Types.String)
    async get(domainId: string, id: string) {
        this.checkPriv(PRIV.PRIV_MOD_BADGE);
        const client = await oi33Model.getClient(id);
        if (!client) throw new NotFoundError(id);
        const baseUrl = SystemModel.get('server.url') as string || '/';
        this.response.template = 'oi33_oauth_client_show.html';
        this.response.body = {
            client,
            baseUrl: baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_oauth_authorize', '/oi33/oauth/authorize', OAuthAuthorizeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_oauth_token', '/oi33/oauth/token', OAuthTokenHandler);
    ctx.Route('oi33_oauth_userinfo', '/oi33/oauth/userinfo', OAuthUserInfoHandler);
    ctx.Route('oi33_oauth_revoke', '/oi33/oauth/revoke', OAuthRevokeHandler);
    ctx.Route('oi33_oauth_clients', '/oi33/oauth/clients', OAuthClientsHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_oauth_client_create', '/oi33/oauth/clients/create', OAuthClientCreateHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_oauth_client_show', '/oi33/oauth/clients/:id', OAuthClientShowHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_oauth_client_delete', '/oi33/oauth/clients/:id/delete', OAuthClientDeleteHandler, PRIV.PRIV_MOD_BADGE);
}
