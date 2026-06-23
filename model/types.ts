import { ObjectId } from 'hydrooj';

export type Oi33RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type Oi33RequestKind = 'birthday' | 'realname' | 'badge' | 'atcoder' | 'codeforces';

export interface Oi33RequestPayload {
    birthday_date?: string;
    realname_flag?: number;
    realname_name?: string;
    badge_text?: string;
    badge_color?: string;
    badge_textColor?: string;
    atcoder?: string;
    codeforces?: string;
}

export interface Oi33Request extends Oi33RequestPayload {
    _id: ObjectId;
    uid: number;
    kind: Oi33RequestKind;
    requester: number;
    status: Oi33RequestStatus;
    createdAt: Date;
    handledAt?: Date;
    handler?: number;
}

export interface Oi33User {
    _id: number;
    coin_now?: number;
    coin_all?: number;
    birthday_date?: string;
    birthday_monthDay?: string;
    badge_text?: string;
    badge_color?: string;
    badge_textColor?: string;
    realname_flag?: number;
    realname_name?: string;
    checkin_time?: string;
    checkin_luck?: number;
    checkin_cnt_now?: number;
    checkin_cnt_all?: number;
    atcoder?: string;
    codeforces?: string;
    atcoder_rating?: number;
    codeforces_rating?: number;
    atcoder_updated_at?: string;
    codeforces_updated_at?: string;
}

export interface Oi33CoinBill {
    _id: string;
    userId: number;
    rootId: number;
    amount: number;
    text: string;
}

export interface Oi33Paste {
    _id: string;
    updateAt: Date;
    title: string;
    owner: number;
    content: string;
    isprivate: boolean;
}

export interface Oi33Wiki {
    _id: string;
    title: string;
    content: string;
    category: string;
    order: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface Oi33WikiCategoryDoc {
    _id: string;
    name: string;
    order: number;
}

export interface Oi33Token {
    _id: string;
    tokenHash: string;
    tokenPrefix: string;
    uid: number;
    name: string;
    domains: string[];
    createdAt: Date;
    lastUsedAt: Date;
    expiresAt?: Date;
    isActive: boolean;
}

export type Oi33OAuthScope = 'profile';

export interface Oi33OAuthClient {
    _id: string;
    name: string;
    description?: string;
    secretHash?: string;
    secretPrefix?: string;
    redirectUris: string[];
    scopes: Oi33OAuthScope[];
    isPublic: boolean;
    accessTokenTtl: number;
    refreshTokenTtl: number;
    createdAt: Date;
    createdBy: number;
    isActive: boolean;
}

export interface Oi33OAuthCode {
    _id: string;
    clientId: string;
    uid: number;
    redirectUri: string;
    scopes: Oi33OAuthScope[];
    codeChallenge?: string;
    codeChallengeMethod?: 'S256' | 'plain';
    expiresAt: Date;
    consumed: boolean;
}

export interface Oi33OAuthToken {
    _id: string;
    tokenHash: string;
    tokenPrefix: string;
    clientId: string;
    uid: number;
    scopes: Oi33OAuthScope[];
    expiresAt: Date;
    createdAt: Date;
    lastUsedAt: Date;
    isActive: boolean;
}

export interface Oi33OAuthRefreshToken {
    _id: string;
    tokenHash: string;
    clientId: string;
    uid: number;
    scopes: Oi33OAuthScope[];
    expiresAt: Date;
    createdAt: Date;
    isActive: boolean;
}

export interface Oi33Log {
    _id: ObjectId;
    createdAt: Date;
    type: 'coin' | 'birthday' | 'badge' | 'realname' | 'paste' | 'request' | 'wiki' | 'oauth';
    sender?: number;
    receiver?: number;
    amount?: number;
    reason?: string;
    userId?: number;
    birthdayDate?: string;
    badgeText?: string;
    badgeColor?: string;
    badgeTextColor?: string;
    realnameName?: string;
    owner?: number;
    title?: string;
    pasteId?: string;
    wikiId?: string;
    action?: string;
    rejectReason?: string;
    requester?: number;
    reqId?: string;
    status?: Oi33RequestStatus;
    kind?: Oi33RequestKind;
    uid?: number;
    oauthClientId?: string;
    oauthAction?: 'authorize' | 'deny' | 'token' | 'refresh' | 'revoke' | 'client_create' | 'client_delete';
    oauthScopes?: string[];
}
