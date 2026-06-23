import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { db } from 'hydrooj';
import {
    Oi33OAuthClient, Oi33OAuthCode, Oi33OAuthToken,
    Oi33OAuthRefreshToken, Oi33OAuthScope,
} from './types';
import { addLog } from './log';

export const clientColl = db.collection('oi33_oauth_client');
export const codeColl = db.collection('oi33_oauth_code');
export const tokenColl = db.collection('oi33_oauth_token');
export const refreshColl = db.collection('oi33_oauth_refresh');

export const DEFAULT_SCOPES: Oi33OAuthScope[] = ['profile'];

const CODE_TTL_SECONDS = 600;
const DEFAULT_ACCESS_TTL = 3600;
const DEFAULT_REFRESH_TTL = 30 * 24 * 3600;

function randId(len = 16): string {
    return randomBytes(len).toString('hex');
}

function genClientId(): string {
    return '33oj_' + randomBytes(12).toString('base64url');
}

function genClientSecret(): string {
    return '33ojcs_' + randomBytes(32).toString('base64url');
}

function genAccessToken(): string {
    return '33oat_' + randomBytes(32).toString('base64url');
}

function genRefreshToken(): string {
    return '33ojrt_' + randomBytes(32).toString('base64url');
}

function genCode(): string {
    return randId(20);
}

function hashSecret(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

// --- Clients ---

export async function createClient(
    name: string, redirectUris: string[], scopes: Oi33OAuthScope[],
    createdBy: number, isPublic: boolean, description?: string,
    accessTokenTtl?: number, refreshTokenTtl?: number,
): Promise<{ client: Oi33OAuthClient; rawSecret: string | null }> {
    const _id = genClientId();
    let rawSecret: string | null = null;
    let secretHash: string | undefined;
    let secretPrefix: string | undefined;
    if (!isPublic) {
        rawSecret = genClientSecret();
        secretHash = hashSecret(rawSecret);
        secretPrefix = rawSecret.slice(0, 16);
    }
    const client: Oi33OAuthClient = {
        _id,
        name,
        description: description || '',
        secretHash,
        secretPrefix,
        redirectUris,
        scopes,
        isPublic,
        accessTokenTtl: accessTokenTtl || DEFAULT_ACCESS_TTL,
        refreshTokenTtl: refreshTokenTtl || DEFAULT_REFRESH_TTL,
        createdAt: new Date(),
        createdBy,
        isActive: true,
    };
    await clientColl.insertOne(client);
    await addLog({ type: 'oauth', oauthAction: 'client_create', oauthClientId: _id, uid: createdBy });
    return { client, rawSecret };
}

export async function getClients(): Promise<Oi33OAuthClient[]> {
    return await clientColl.find({ isActive: true }).sort({ createdAt: -1 }).toArray();
}

export async function getClient(id: string): Promise<Oi33OAuthClient | null> {
    return await clientColl.findOne({ _id: id, isActive: true });
}

export async function deleteClient(id: string): Promise<boolean> {
    const r = await clientColl.updateOne({ _id: id }, { $set: { isActive: false } });
    if (r.modifiedCount) {
        await tokenColl.updateMany({ clientId: id }, { $set: { isActive: false } });
        await refreshColl.updateMany({ clientId: id }, { $set: { isActive: false } });
        await addLog({ type: 'oauth', oauthAction: 'client_delete', oauthClientId: id });
    }
    return r.modifiedCount > 0;
}

export function verifyClientSecret(client: Oi33OAuthClient, rawSecret: string): boolean {
    if (client.isPublic) return false;
    if (!client.secretHash) return false;
    return safeEqual(hashSecret(rawSecret), client.secretHash);
}

export function redirectAllowed(client: Oi33OAuthClient, redirectUri: string): boolean {
    return client.redirectUris.includes(redirectUri);
}

// --- Authorization codes ---

export async function createCode(
    client: Oi33OAuthClient, uid: number, redirectUri: string,
    scopes: Oi33OAuthScope[], codeChallenge?: string, codeChallengeMethod?: 'S256' | 'plain',
): Promise<string> {
    const code = genCode();
    await codeColl.insertOne({
        _id: code,
        clientId: client._id,
        uid,
        redirectUri,
        scopes,
        codeChallenge,
        codeChallengeMethod,
        expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
        consumed: false,
    } as Oi33OAuthCode);
    await addLog({
        type: 'oauth', oauthAction: 'authorize', oauthClientId: client._id,
        uid, oauthScopes: scopes,
    });
    return code;
}

export async function consumeCode(code: string): Promise<Oi33OAuthCode | null> {
    const doc = await codeColl.findOne({ _id: code, consumed: false });
    if (!doc) return null;
    if (new Date(doc.expiresAt) < new Date()) return null;
    await codeColl.updateOne({ _id: code }, { $set: { consumed: true } });
    return doc;
}

// --- Access + refresh tokens ---

export async function createAccessToken(
    client: Oi33OAuthClient, uid: number, scopes: Oi33OAuthScope[],
): Promise<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: Date; refreshTokenExpiresAt: Date }> {
    const accessToken = genAccessToken();
    const refreshToken = genRefreshToken();
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + client.accessTokenTtl * 1000);
    const refreshExpiresAt = new Date(now.getTime() + client.refreshTokenTtl * 1000);
    await tokenColl.insertOne({
        _id: randId(),
        tokenHash: hashSecret(accessToken),
        tokenPrefix: accessToken.slice(0, 20),
        clientId: client._id,
        uid,
        scopes,
        expiresAt: accessExpiresAt,
        createdAt: now,
        lastUsedAt: now,
        isActive: true,
    } as Oi33OAuthToken);
    await refreshColl.insertOne({
        _id: randId(),
        tokenHash: hashSecret(refreshToken),
        clientId: client._id,
        uid,
        scopes,
        expiresAt: refreshExpiresAt,
        createdAt: now,
        isActive: true,
    } as Oi33OAuthRefreshToken);
    await addLog({
        type: 'oauth', oauthAction: 'token', oauthClientId: client._id,
        uid, oauthScopes: scopes,
    });
    return { accessToken, refreshToken, accessTokenExpiresAt: accessExpiresAt, refreshTokenExpiresAt: refreshExpiresAt };
}

export async function getAccessTokenByRaw(raw: string): Promise<Oi33OAuthToken | null> {
    const doc = await tokenColl.findOne({ tokenHash: hashSecret(raw), isActive: true });
    if (!doc) return null;
    if (new Date(doc.expiresAt) < new Date()) return null;
    await tokenColl.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } });
    return doc;
}

export async function refreshAccessToken(rawRefresh: string): Promise<{
    client: Oi33OAuthClient; uid: number; scopes: Oi33OAuthScope[];
    accessToken: string; accessTokenExpiresAt: Date;
} | null> {
    const rdoc = await refreshColl.findOne({ tokenHash: hashSecret(rawRefresh), isActive: true });
    if (!rdoc) return null;
    if (new Date(rdoc.expiresAt) < new Date()) return null;
    const client = await getClient(rdoc.clientId);
    if (!client) return null;
    const accessToken = genAccessToken();
    const now = new Date();
    const accessExpiresAt = new Date(now.getTime() + client.accessTokenTtl * 1000);
    await tokenColl.insertOne({
        _id: randId(),
        tokenHash: hashSecret(accessToken),
        tokenPrefix: accessToken.slice(0, 20),
        clientId: client._id,
        uid: rdoc.uid,
        scopes: rdoc.scopes,
        expiresAt: accessExpiresAt,
        createdAt: now,
        lastUsedAt: now,
        isActive: true,
    } as Oi33OAuthToken);
    await addLog({
        type: 'oauth', oauthAction: 'refresh', oauthClientId: client._id,
        uid: rdoc.uid, oauthScopes: rdoc.scopes,
    });
    return { client, uid: rdoc.uid, scopes: rdoc.scopes, accessToken, accessTokenExpiresAt: accessExpiresAt };
}

export async function revokeToken(raw: string): Promise<boolean> {
    const doc = await tokenColl.findOne({ tokenHash: hashSecret(raw), isActive: true });
    if (doc) {
        await tokenColl.updateOne({ _id: doc._id }, { $set: { isActive: false } });
        await addLog({ type: 'oauth', oauthAction: 'revoke', oauthClientId: doc.clientId, uid: doc.uid });
        return true;
    }
    const rdoc = await refreshColl.findOne({ tokenHash: hashSecret(raw), isActive: true });
    if (rdoc) {
        await refreshColl.updateOne({ _id: rdoc._id }, { $set: { isActive: false } });
        await addLog({ type: 'oauth', oauthAction: 'revoke', oauthClientId: rdoc.clientId, uid: rdoc.uid });
        return true;
    }
    return false;
}

export async function revokeAllForClient(clientId: string) {
    await tokenColl.updateMany({ clientId, isActive: true }, { $set: { isActive: false } });
    await refreshColl.updateMany({ clientId, isActive: true }, { $set: { isActive: false } });
}

export async function logDeny(clientId: string, uid: number) {
    await addLog({ type: 'oauth', oauthAction: 'deny', oauthClientId: clientId, uid });
}
