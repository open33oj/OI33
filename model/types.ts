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
    school_cat?: number;
    school_cat_food?: number;
    school_cat_month?: string;
    school_cat_feed_at?: Date;
    // Idempotency marker for the most recent weekly big-cat reward applied to
    // this account. A user can only belong to one current big cat per period.
    school_cat_reward_period?: string;
    school_cat_reward_amount?: number;
    school_cat_reward_school_id?: number;
    school_cat_reward_at?: Date;
    // Stable run keys make weekly settlement/re-settlement idempotent even
    // after a newer week has replaced the convenience fields above.
    school_cat_reward_keys?: string[];
    school_cat_reward_rollback_keys?: string[];
    school_cat_reward_revision?: number;
    // Short-lived cross-process lock used to serialize meow submissions.
    meow_post_lock?: ObjectId;
    meow_post_lock_at?: Date;
    // User-picked medal ids shown in the profile showcase grid (max 16).
    medal_showcase?: string[];
    // Bio AI moderation: status of the bio version identified by bio_hash.
    // Only approved + hash-matching bios are displayed; edits re-review.
    bio_status?: 'pending' | 'approved' | 'rejected';
    bio_hash?: string;
    bio_edited_at?: Date; // last actual bio change, drives the 2h edit cooldown
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
    // Anchor captured on creation (and locked on first calibration): the
    // supply that existed before any admin grants / weekly rewards / their
    // rollbacks. Calibration recomputes virtualCanSupply as
    // baseVirtualSupply + minted - burned from the ledger.
    baseVirtualSupply?: number;
    feesBurned: number;
    userFoodTotal: number;
    circulatingCans: number;
    balanceCounterVersion: number;
    // The weekly reward pool update is applied once per Shanghai week. The
    // matching reward plan remains the source of the per-user breakdown.
    schoolCatRewardPeriod?: string;
    schoolCatRewardCans?: number;
    schoolCatRewardAt?: Date;
    schoolCatRewardRevision?: number;
    schoolCatRewardKeys?: string[];
    schoolCatRewardRollbackKeys?: string[];
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
    freeColorAvailable?: boolean;
    movementLock?: ObjectId;
    movementLockAt?: Date;
}

export interface Oi33CatMapCell {
    _id: string;
    x: number;
    y: number;
    color: number;
    // 0 = no big cat; otherwise OIerDB school id + 1 (school #0 stays usable).
    catId: number;
    updatedBy: number;
    updatedAt: Date;
}

// One planned step = move to the adjacent cell (x, y) and then paint it.
export interface Oi33CatMapPlanStep {
    x: number;
    y: number;
    color: number;
}

// Planned route of one user. _id is the uid, so a user can only ever have one
// plan; finished/stopped documents stay around to show their stop reason and
// are overwritten by the next plan.
export interface Oi33CatMapPlan {
    _id: number;
    steps: Oi33CatMapPlanStep[];
    // Index of the next step to execute; steps before it are already done.
    cursor: number;
    status: 'active' | 'done' | 'stopped';
    // Cell the cat stood on when the plan was (re)built: the continuity base of
    // cursor 0 (later steps are anchored on steps[cursor - 1]).
    originX: number;
    originY: number;
    // Earliest time the next step may run (= the player's availableAt).
    nextAt: Date;
    // Consecutive retryable failures (concurrent movement lock contention).
    attempts?: number;
    failReason?: string;
    // Execution lease, same idea as the weekly school-cat reward lock.
    lockOwner?: ObjectId;
    lockUntil?: Date;
    createdAt: Date;
    updatedAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
}

export interface Oi33CatMapConfig {
    _id: string;
    // Maximum number of steps in one cat map plan (clamped on write).
    planMaxSteps: number;
    updatedAt: Date;
}

export interface Oi33School {
    _id: number;
    prov: string;
    abbr: string;
}

export interface Oi33SchoolCat {
    // Negative ids are special big cats: custom-named admin cats that live
    // only in this collection and never collide with OIerDB schools.
    _id: number;
    currentWeight: number;
    historyWeight: number;
    territoryColor: number;
    territoryCount: number;
    // Only special big cats (negative _id) carry a custom display name.
    name?: string;
    spawnedAt: Date;
    updatedAt: Date;
}

export interface Oi33SchoolFeedHistory {
    _id: ObjectId;
    uid: number;
    schoolId: number;
    amount: number;
    createdAt: Date;
}

export interface Oi33SchoolCatRewardAllocation {
    uid: number;
    schoolId: number;
    contribution: number;
    weight: number;
    amount: number;
    isAdminCat: boolean;
}

export interface Oi33SchoolCatRewardSummary {
    schoolId: number;
    isAdminCat: boolean;
    territoryCount: number;
    feederCount: number;
    baseCans: number;
    multiplier: number;
    plannedCans: number;
    // Big-cat weight in grams at snapshot time. Absent in snapshots planned
    // before the weight-based multiplier rule; treat as unknown.
    weightGrams?: number;
}

export interface Oi33SchoolCatReward {
    _id: string; // Asia/Shanghai Monday date: YYYY-MM-DD
    status: 'planned' | 'processing' | 'completed' | 'failed'
        | 'rolling_back' | 'rollback_failed' | 'rolled_back';
    revision: number;
    cats: Oi33SchoolCatRewardSummary[];
    allocations: Oi33SchoolCatRewardAllocation[];
    plannedUsers: number;
    plannedCans: number;
    issuedUsers?: number;
    issuedCans?: number;
    // Set once the 5% weekly food decay has been applied for this batch.
    // Absent on batches settled before the decay rule existed.
    foodDecayed?: boolean;
    operator: number; // 0 = automatic scheduler
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    failedAt?: Date;
    lastError?: string;
    rollbackStartedAt?: Date;
    rolledBackAt?: Date;
    rolledBackBy?: number;
    rollbackReason?: string;
    history?: Array<{
        revision: number;
        status: string;
        plannedUsers: number;
        plannedCans: number;
        issuedUsers?: number;
        issuedCans?: number;
        createdAt: Date;
        completedAt?: Date;
        rolledBackAt?: Date;
        rolledBackBy?: number;
        rollbackReason?: string;
        cats: Oi33SchoolCatRewardSummary[];
    }>;
    lockOwner?: ObjectId;
    lockUntil?: Date;
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
    type: 'coin' | 'birthday' | 'badge' | 'realname' | 'checkin' | 'cat_account' | 'cat_map' | 'paste' | 'request' | 'wiki' | 'oauth' | 'school_cat' | 'meow' | 'medal' | 'auction' | 'contract' | 'admin';
    sender?: number;
    operator?: number;
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
    postId?: string;
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
    catId?: number;
    // Cat-food map moves write this marker when their cost has already been
    // included in the mover's current big-cat contribution. Legacy logs lack it.
    schoolCatContributionCounted?: boolean;
    schoolCatContributionBatch?: ObjectId;
    schoolCatRewardPeriod?: string;
    schoolCatRewardRevision?: number;
    rowStart?: number;
    columnStart?: number;
    rowEnd?: number;
    columnEnd?: number;
    medalId?: string;
    // Certification medals (奖项认证奖章) log the rung that was granted or
    // moved to, so the admin timeline can show the ladder movement.
    level?: number;
    auctionId?: string;
    contractId?: string;
}

// --- Medals ---

export type Oi33MedalImageSize = 8 | 16 | 24 | 32;
export type Oi33MedalRuleType =
    | 'manual'
    | 'accepted_problems'
    | 'checkin_streak'
    | 'checkin_total'
    | 'cat_food_balance'
    | 'cat_can_balance'
    | 'certification';

// The rule types a rule evaluator may dispatch on. Certification medals are
// never automatic (an administrator hands them out and upgrades them) and
// `manual` definitions only exist to be granted by hand.
export type Oi33MedalAutomaticRuleType = Exclude<Oi33MedalRuleType, 'manual' | 'certification'>;

// The four public medal families. `category` is never stored: it is derived
// from `ruleType` + `saleable` by `medalCategoryOf()` so the definition stays
// the single source of truth.
//   oj            OJ 成就奖章     — one upgradable level series per indicator,
//                                   upgraded automatically by a rule evaluator
//   saleable      可售卖奖章     — auctioned / traded between users
//   manual        一般奖章       — granted by hand by an administrator
//   certification 奖项认证奖章   — one series per contest, upgradable by level
export type Oi33MedalCategory = 'oj' | 'saleable' | 'manual' | 'certification';

// One rung of an upgradable series. `level` is 1-based and ascending: the
// higher the number, the better the award. Certification series (奖项认证奖章)
// use it to record the best contest award; OJ 成就奖章 series use `threshold`
// to record the metric value at which the rung is reached.
export interface Oi33MedalLevel {
    level: number;
    name: string;
    description?: string;
    imageData: string;
    imageSize: Oi33MedalImageSize;
    // OJ 成就奖章 only: the indicator value required to reach this rung. The
    // rule evaluator grants the highest rung whose threshold is met.
    threshold?: number;
}

// Definitions are deliberately data-driven. `rule` is a stable, human-readable
// condition for now; future automatic evaluators can dispatch by `_id` while all
// awards continue to flow through the same idempotent grant function.
export interface Oi33Medal {
    _id: string;
    name: string;
    description: string;
    rule: string;
    ruleType: Oi33MedalRuleType;
    threshold?: number;
    imageData: string;
    imageSize: Oi33MedalImageSize;
    // Upgradable series only (奖项认证奖章 / OJ 成就奖章): the ordered level
    // ladder. The base `imageData`/`imageSize` stay as the series icon used in
    // admin lists. For OJ series every rung carries its own `threshold`.
    levels?: Oi33MedalLevel[];
    order: number;
    // When true, a user who won this medal at auction may resell it
    // through a direct trade contract.
    saleable?: boolean;
    createdAt: Date;
    updatedAt: Date;
    createdBy: number;
}

// Definition plus its derived category, as returned by every model list/get
// helper so templates never have to re-derive the classification.
export type Oi33MedalView = Oi33Medal & { category: Oi33MedalCategory };

export interface Oi33UserMedal {
    _id: ObjectId;
    uid: number;
    medalId: string;
    earnedAt: Date;
    grantedBy: number;
    source: string;
    // Upgradable series only (奖项认证奖章 / OJ 成就奖章): the currently held
    // rung. Absent on every other family, where the medal is held or not held
    // at all.
    level?: number;
    announcementPostId?: ObjectId;
}

// --- Medal auctions ---

export interface Oi33Auction {
    _id: ObjectId;
    medalId: string;
    startPrice: number;
    startAt: Date;
    // The administrator-selected deadline. `endAt` is the effective deadline
    // and may be extended so every accepted bid remains contestable for 1 min.
    scheduledEndAt?: Date;
    endAt: Date;
    lastBidAt?: Date;
    createdBy: number;
    createdAt: Date;
    status: 'active' | 'settled' | 'cancelled';
    highestBid: number | null;
    highestBidder: number | null;
    bidCount: number;
    winner?: number;
    settlePrice?: number;
    // Reserve food burned at settlement (= settlePrice cans × sell price at
    // settle time, clamped to the reserve). Absent on legacy settlements.
    foodBurn?: number;
    settledAt?: Date;
    cancelledAt?: Date;
    cancelledBy?: number;
}

export interface Oi33AuctionBid {
    _id: ObjectId;
    auctionId: ObjectId;
    uid: number;
    amount: number;
    createdAt: Date;
}

// --- Medal trade contracts ---

export interface Oi33Contract {
    _id: ObjectId;
    medalId: string;
    seller: number;
    buyer: number;
    // Cat food price in grams.
    price: number;
    // Intermediary fee in grams (5% of price, ceiled), deducted from the
    // seller's proceeds and burned on accept. Absent on legacy contracts.
    fee?: number;
    status: 'pending' | 'accepted' | 'declined' | 'cancelled';
    createdAt: Date;
    resolvedAt?: Date;
}

export interface Oi33AiAnalysis {
    _id: string;
    rid: string;
    userId: number;
    problem: string;
    results: string;
    code: string;
    language: string;
    suggestion: string;
    createdAt: Date;
}

export interface Oi33AiConfig {
    _id: string;
    // Model names resolved against ai33_provider entries.
    student_model: string;
    teacher_model: string;
    summary_model: string;
    // Optional system-prompt overrides; empty/missing → built-in defaults.
    student_prompt?: string;
    teacher_prompt?: string;
    summary_prompt?: string;
    difficulty_prompt?: string;
    // Per-role DeepSeek thinking-mode effort: low / high / max (empty = high).
    student_effort?: string;
    teacher_effort?: string;
    summary_effort?: string;
    // Legacy global effort, kept as a fallback for analyses.
    analysis_effort?: string;
    // Discussion moderation: '1' = on, anything else = off.
    moderation_enabled?: string;
    moderation_model?: string;
    // System-prompt override; empty → built-in default.
    moderation_prompt?: string;
    // Newline-separated blocked words (rule layer, matched after normalization).
    moderation_words?: string;
    // Newline-separated words that go to the human review queue instead of
    // being hard-blocked (e.g. political leader names).
    moderation_review_words?: string;
    // Daily AI cost cap for moderation in CNY; 0/empty = unlimited.
    moderation_daily_budget?: number;
    // Per-user moderated posts per day; 0/empty = default (50).
    moderation_rate_limit?: number;
}

export type Oi33ModerationKind = 'topic' | 'reply' | 'tailreply' | 'topic_edit' | 'reply_edit' | 'tailreply_edit' | 'bio';
export type Oi33ModerationVerdict = 'pass' | 'block' | 'review';
export type Oi33ModerationSource = 'rules' | 'ai' | 'cache' | 'fuse' | 'ratelimit' | 'error';
// 'stale' = closed without a decision because the entry can never be applied
// any more (the reviewed version of the bio is gone, or the record was
// superseded by a newer edit). Without it those records stayed 'pending'
// forever and every click on them failed, clogging the queue.
export type Oi33ModerationStatus = 'done' | 'pending' | 'approved' | 'rejected' | 'stale';

// Where a moderation entry points to; used to hide / unhide / delete the content.
export interface Oi33ModerationTarget {
    domainId: string;
    did?: ObjectId;
    drid?: ObjectId;
    drrid?: ObjectId;
}

// --- 喵喵 (犇犇-style short blog) ---

export type Oi33MeowStatus = 'pending' | 'approved' | 'rejected';

// One short post. `status` is the single source of truth for visibility
// (only 'approved' posts ever appear in feeds). Rules/AI verdict fields are
// filled in by the background moderation pass (same engine as discussions).
// A forward (转发) references another post via `ref` (its author cached in
// `refUid`), forming a chain rendered as `内容 || @user : 内容 || ...`.
export interface Oi33MeowPost {
    _id: ObjectId;
    uid: number;
    content: string;
    // Asia/Shanghai 'YYYY-MM-DD' of submission, for the admin "今日" stats.
    dateKey: string;
    status: Oi33MeowStatus;
    likeCount: number;
    verdict?: Oi33ModerationVerdict;
    verdictSource?: Oi33ModerationSource;
    category?: string;
    aiReason?: string;
    model?: string;
    cost?: number;
    createdAt: Date;
    handledAt?: Date;
    handler?: number;
    // Forward chain: this post forwards `ref` (author cached as `refUid`).
    ref?: ObjectId;
    refUid?: number;
    // User submissions consume the daily free slot or one can. Medal
    // announcements are system posts and affect neither balance nor cooldown.
    canCost?: number;
    dailyFree?: boolean;
    source?: 'medal';
    medalId?: string;
}

// One-way follow relationship (Twitter-style): `follower` follows `following`.
export interface Oi33MeowFollow {
    _id: ObjectId;
    follower: number;
    following: number;
    createdAt: Date;
}

export interface Oi33MeowLike {
    _id: ObjectId;
    uid: number;
    postId: ObjectId;
    createdAt: Date;
}

export interface Oi33AiModeration {
    _id: ObjectId;
    uid: number;
    kind: Oi33ModerationKind;
    contentHash: string;
    preview: string; // first ~120 chars of the normalized content
    content: string; // full content; needed to execute a pending entry on approve
    target?: Oi33ModerationTarget;
    verdict: Oi33ModerationVerdict;
    source: Oi33ModerationSource;
    category: string;
    // AI's free-text reason; admin-only, never shown to the poster.
    aiReason?: string;
    model?: string;
    cost?: number;
    status: Oi33ModerationStatus;
    createdAt: Date;
    handledAt?: Date;
    handler?: number;
}

export interface Oi33AiProblemSummary {
    _id: string; // `${domainId}:${pid}`
    domainId: string;
    pid: number;
    content: string;
    model: string;
    // AI-judged difficulty on the Luogu 0-8 scale (1-8); shown as a reference
    // badge and applied to the problem only when it has no rating yet.
    difficulty?: number;
    difficultyModel?: string;
    createdAt: Date;
}

export interface Oi33AiBatchStatus {
    _id: string; // 'current' = summary batch, 'bio_review' = bio moderation batch
    running: boolean;
    domainId?: string; // target domain, default system
    start?: string; // sort range endpoints, e.g. "1000" or "ABC123A"
    end?: string;
    total: number;
    done: number;
    generated: number; // summaries newly generated / bios approved
    difficulties: number; // AI difficulties newly judged
    applied: number; // problems whose difficulty was set / bios rejected
    skipped: number;
    failed: number;
    currentSort?: string;
    startedAt: Date;
    finishedAt?: Date;
    lastError?: string;
}

export interface Oi33AiProviderModel {
    name: string;
    input: number; // price per 1M tokens (cache miss)
    inputCached: number; // price per 1M tokens (cache hit)
    output: number; // price per 1M tokens
}

export interface Oi33AiProvider {
    _id: string; // provider name
    baseUrl: string;
    apiKey: string;
    models: Oi33AiProviderModel[];
}

export interface Oi33AiAccess {
    _id: number; // uid
    balance: number;
    granted?: number; // total quota ever granted; balance = granted - used
    unlimited: boolean;
    createdAt: Date;
}

export interface Oi33AiUsage {
    _id: ObjectId;
    uid: number; // 0 = system (e.g. summary generation)
    type: 'analysis' | 'summary' | 'moderation';
    rid?: string;
    domainId?: string;
    pid?: number;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cost: number;
    deducted: boolean; // whether cost was charged to a user balance
    createdAt: Date;
}
