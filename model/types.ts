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
    cat_food?: number;
    cat_food_backfill_version?: number;
    cat_food_backfilled_at?: Date;
    cat_can?: number;
    cat_can_trade_available_at?: Date;
    atcoder?: string;
    codeforces?: string;
    atcoder_rating?: number;
    codeforces_rating?: number;
    atcoder_updated_at?: string;
    codeforces_updated_at?: string;
}

export interface Oi33CatCanBatch {
    _id: ObjectId;
    uid: number;
    quantity: number;
    remaining: number;
    unitPrice: number;
    purchasedAt: Date;
    expiresAt?: Date;
    expiredAt?: Date;
    adjustment?: 'reversal';
    originalBillId?: ObjectId;
}

export interface Oi33CatCanBill {
    _id: ObjectId;
    uid: number;
    action: 'buy' | 'sell' | 'expire' | 'reverse';
    originalAction?: 'buy' | 'sell';
    originalBillId?: ObjectId;
    quantity: number;
    unitPrice: number;
    tradeAmount?: number;
    fee?: number;
    catFoodDelta: number;
    batchId?: ObjectId;
    expiresAt?: Date;
    balanceAfter?: number;
    inventoryAfter?: number;
    reversedAt?: Date;
    reversedBy?: number;
    reversalReason?: string;
    reversalBillId?: ObjectId;
    createdAt: Date;
}

export interface Oi33CatFoodBatchPreview {
    _id: ObjectId;
    operator: number;
    items: Array<{ uid: number; amount: number; reason: string }>;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    createdAt: Date;
    expiresAt: Date;
    confirmedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
    total?: number;
    error?: string;
}

export interface Oi33CatCanPool {
    _id: 'main';
    reserveFood: number;
    virtualCanSupply: number;
    feesBurned: number;
    userFoodTotal: number;
    circulatingCans: number;
    balanceCounterVersion: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface Oi33CatCanPrice {
    _id: Date;
    sellPrice: number;
    buyPrice: number;
    userFood?: number;
    userCans?: number;
    reserveFood?: number;
    virtualCanSupply?: number;
    poolCans?: number;
    feesBurned?: number;
    createdAt: Date;
}

export interface Oi33CatMapPlayer {
    _id: number;
    x: number;
    y: number;
    stackable?: boolean;
    createdAt: Date;
    joinedAt?: Date;
    updatedAt: Date;
    movedAt?: Date;
    availableAt?: Date;
    movementLock?: ObjectId;
    movementLockAt?: Date;
}

export interface Oi33CatMapCell {
    _id: string;
    x: number;
    y: number;
    color: number;
    updatedBy: number;
    updatedAt: Date;
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
    type: 'coin' | 'birthday' | 'badge' | 'realname' | 'checkin' | 'cat_account' | 'cat_map' | 'paste' | 'request' | 'wiki' | 'oauth';
    sender?: number;
    receiver?: number;
    amount?: number;
    canAmount?: number;
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
    batchId?: ObjectId;
    batchIndex?: number;
    oauthClientId?: string;
    oauthAction?: 'authorize' | 'deny' | 'token' | 'refresh' | 'revoke' | 'client_create' | 'client_delete';
    oauthScopes?: string[];
    x?: number;
    y?: number;
    color?: number;
    rowStart?: number;
    columnStart?: number;
    rowEnd?: number;
    columnEnd?: number;
}
