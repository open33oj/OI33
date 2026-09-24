import {
    getUserDataByUids, mergeOi33Fields, anonymizeOi33Identity,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
    previewCatFoodBackfill, backfillCatFoodForUser, backfillAllCatFood,
    getAllUsersData, getRatedUsers,
    bioMarkEdited, bioSetStatus, bioSetReviewed,
    expirePendingBioEntries, expireStaleBioEntries, getLiveBio, getLiveBios,
} from './user';
import {
    pasteAdd, pasteEdit, pasteGet, pasteDel, pasteCountUser, pasteGetUser,
} from './paste';
import {
    wikiAdd, wikiImport, wikiEdit, wikiGet, wikiGetApproved, wikiGetOrCreateIndex,
    wikiDelete,
    wikiCatGetAll, wikiCatAdd, wikiCatEdit, wikiCatDelete,
} from './wiki';
import {
    submitRequest, directUpdate, approveRequest, rejectRequest,
    getPendingRequests, getPendingRequestCount,
    getRequestById, getRequestsByIds, getUserPendingRequests,
    applyRequestPayload,
} from './request';
import {
    createToken, getTokensByUid, getAllActiveTokens, getTokenByHash, deleteToken, touchToken,
} from './token';
import {
    createClient, getClients, getClient, deleteClient, verifyClientSecret,
    redirectAllowed, createCode, consumeCode,
    createAccessToken, getAccessTokenByRaw, refreshAccessToken, revokeToken, revokeAllForClient,
    logDeny, DEFAULT_SCOPES,
} from './oauth';
import {
    getRecentActivities, getRecentActivitiesPaginated, compactRequestLogs,
    getCatFoodLogCount, getCatFoodLogs,
} from './log';
import {
    getOrCreateCurrentMarket, getCurrentQuote, getCatCanDayChange, ensureCurrentCatCanPrice,
    ensureCatCanIndexes, ensureCatCanPool, buyCatCans, sellCatCans, adjustCatCans, calibrateCatCanPool,
    getCatCanPage,
    CAT_CAN_ADMIN_ADJUSTMENT_MAX,
} from './cat-can';
import {
    ensureCatAccountIndexes, formatCatFood, getCatAccountPage, grantCatFood,
    createCatFoodBatchPreview, getCatFoodBatchPreview, confirmCatFoodBatchPreview,
    reverseCatCanTransaction, purgeUnverifiedCatAssets,
} from './cat-account';
import {
    ensureCatMapIndexes, joinCatMapPlayer, getCatMapSnapshot,
    moveCatMapPlayer, setCatMapCellColor, adminPaintCatMap, adminRelocateCatMapPlayer,
    refreshCatMapTerritories, recountSchoolCatTerritories, getCatMapCooldownMinutes,
    getCatMapConfig, saveCatMapConfig, getCatMapPlan, getCatMapPlanView,
    saveCatMapPlan, stopCatMapPlan, advanceCatMapPlan, runCatMapPlansDue,
    buildCatMapPlanView, validateCatMapPlanShape, normalizeCatMapPlanMaxSteps,
    CAT_MAP_PLAN_MAX_STEPS_DEFAULT, CAT_MAP_PLAN_MAX_STEPS_LIMIT, CAT_MAP_PLAN_RETRY_LIMIT,
} from './cat-map';
import {
    ensureSchoolCatIndexes, searchSchools, listSchools, getSchool, getSchoolView,
    getBigCatWorldState, getSchoolCatRanking, bindSchoolCat, unbindSchoolCat, feedSchoolCat, getSchoolCatDetail,
    setSchoolCatTerritoryColor, schoolCatKey, schoolIdFromCatKey,
    createSpecialSchoolCat, renameSpecialSchoolCat, listSpecialSchoolCats, transferSchoolCat,
    isAdminSchoolCatRecord, backfillSchoolCatMoveContributions,
    getSchoolCatWeeklyRewardStatus, listSchoolCatWeeklyRewards,
    getSchoolCatWeeklyRewardDetail, getSchoolCatWeeklyRewardRollbackCheck,
    settleSchoolCatWeeklyRewards, rollbackSchoolCatWeeklyRewards,
    schoolCatRewardPeriod, schoolCatTerritoryBaseReward,
    schoolCatColorCss, schoolDisplay, schoolUrl, removeSchoolCatBinding,
} from './school-cat';
import {
    aiGetRecordDetail, aiIsContestRecord,
    aiGetAnalysis, aiSaveAnalysis, aiDeleteAnalysis,
    aiGetProblemSummary, aiSaveProblemSummary, aiSaveProblemDifficulty,
    aiBatchGetStatus, aiBatchSaveStatus,
    aiGetAccess, aiGetAccessList, aiSetAccess, aiAddQuota, aiRemoveAccess, aiDeductBalance,
    aiGetProviders, aiSaveProvider, aiDeleteProvider,
    aiUpsertProviderModel, aiDeleteProviderModel, aiResolveModel,
    aiAddUsage, aiGetUsageStats, aiGetUsedMap,
    aiGetConfig, aiSaveConfig,
} from './ai';
import {
    ensureModerationIndexes, modAdd, modCloseMissingTarget, modGet, modListPending,
    modListRecent, modSetStatus, modExpireEntries,
    modFindCachedVerdict, modCountTodayByUid, modTodayCost, modStats,
    bioHashMatches, bioHashOf, bioQueueState, sameBioText,
} from './moderate';
import {
    ensureMeowIndexes, meowDateKey, meowDailyFreeAvailable,
    meowGetPost, meowLastPost, meowCooldownAnchorPost, meowCooldownRemaining, meowCooldownText, meowRefundCan,
    meowPostAdd, meowMedalPostAdd, meowFeed, meowUserPosts,
    meowResolveVerdict, meowForwardCount, meowListPending, meowListRecent, meowListAll, meowDelete, meowTodayStats, meowSetStatus,
    meowFollow, meowUnfollow, meowIsFollowing,
    meowFollowingList, meowFollowerList, meowFollowingCount, meowFollowerCount,
    meowFollowingMap, meowFollowedByMap,
    meowToggleLike, meowLikedMap,
    setMeowReviewKicker, meowAdminUids, meowHomeFeed, meowBuildChain,
    MEOW_POST_CAN_COST, MEOW_POST_COOLDOWN_MS,
} from './meow';
import {
    ensureMedalIndexes, medalGet, medalList, medalCatalogue, medalSave,
    medalDelete, medalGetUserAwards, medalListRecentAwards, medalAwardStats,
    medalGrant, medalRevoke, medalEvaluateUser, medalEvaluateAll, medalSetLevel,
    medalCategoryOf, medalCategoryName, medalCategoryRank, medalGroupByCategory,
    medalLevelOf, medalDisplayRung, medalSortedLevels, medalAwardView,
    medalIsLevelSeries, medalThresholdLevel, medalAutomaticRuleText,
    medalMigrateAutomaticLevels,
    MEDAL_CATEGORIES, MEDAL_CATEGORY_NAMES, MEDAL_AUTOMATIC_SERIES, AUTOMATIC_RULE_TYPES,
    medalGetAcceptedDomains, medalSetAcceptedDomains,
    medalAcceptedDomainIncluded, medalImportInitialDefinitions,
} from './medal';
import {
    ensureAuctionIndexes, auctionGet, auctionCreate, auctionBid, auctionSettle,
    auctionSettleExpired, auctionCancel, auctionListActive, auctionListRecentFinished,
    auctionGetBids, auctionSaleableShowcase,
} from './auction';
import {
    ensureContractIndexes, contractGet, contractListSellableAwards, contractCreate,
    contractAccept, contractDecline, contractCancel, contractListIncoming,
    contractListOutgoing, contractListRecentResolved,
    CONTRACT_FEE_PERCENT, contractFeeAmount,
} from './contract';
import {
    ensureAlgorithmIndexes, algorithmGetConfig, algorithmSaveConfig,
    algorithmListItems, algorithmGetItem, algorithmCountItems,
    algorithmGroupItems, algorithmComputeStats,
    algorithmProfileView, algorithmSetLevels,
    algorithmMonthKey, algorithmNextUpdateDate,
    algorithmGetSelfQuota, algorithmClaimSelfQuota, algorithmReleaseSelfQuota, algorithmResetSelfQuota,
    algorithmSaveItem, algorithmDeleteItem, algorithmSetItemEnabled, algorithmBulkSetEnabled,
    algorithmImportOutline, algorithmEnsureOutlineImported, algorithmMigrateOutlineIds,
    algorithmOutlineData, algorithmOutlineMeta, normalizeOutlineId,
    algorithmNormalizeLevel, algorithmLevelName,
    ALGORITHM_LEVELS, ALGORITHM_LEVEL_NAMES, ALGORITHM_MAX_LEVEL,
    ALGORITHM_MAX_TEXT, ALGORITHM_MAX_NOTE, ALGORITHM_MAX_GROUP_NAME, ALGORITHM_MAX_ITEMS,
    ALGORITHM_CONFIG_ID,
} from './algorithm';

export * from './types';
export { userColl, billColl } from './user';
export { pasteColl } from './paste';
export { wikiColl, wikiCatColl } from './wiki';
export { requestColl } from './request';
export { tokenColl } from './token';
export {
    clientColl as oauthClientColl, codeColl as oauthCodeColl,
    tokenColl as oauthTokenColl, refreshColl as oauthRefreshColl,
} from './oauth';
export { logColl } from './log';
export { catCanBillColl, catCanPoolColl, catCanPriceColl } from './cat-can';
export { catFoodBatchPreviewColl } from './cat-account';
export { catMapPlayerColl, catMapCellColl, catMapPlanColl, catMapConfigColl } from './cat-map';
export { schoolCatColl, schoolFeedHistoryColl, schoolCatRewardColl } from './school-cat';
export {
    aiAnalysisColl, aiConfigColl, aiProblemSummaryColl,
    aiProviderColl, aiAccessColl, aiUsageColl,
} from './ai';
export { moderationColl } from './moderate';
export { meowPostColl, meowFollowColl, meowLikeColl } from './meow';
export { medalColl, userMedalColl } from './medal';
export { auctionColl, auctionBidColl } from './auction';
export { contractColl } from './contract';
export { algorithmItemColl, userAlgorithmColl, algorithmConfigColl } from './algorithm';

const oi33Model = {
    getUserDataByUids, mergeOi33Fields, anonymizeOi33Identity,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
    previewCatFoodBackfill, backfillCatFoodForUser, backfillAllCatFood,
    bioMarkEdited, bioSetStatus, bioSetReviewed, bioHashMatches, bioHashOf, bioQueueState, sameBioText,
    expirePendingBioEntries, expireStaleBioEntries, getLiveBio, getLiveBios,
    pasteAdd, pasteEdit, pasteGet, pasteDel, pasteCountUser, pasteGetUser,
    getAllUsersData, getRatedUsers, getRecentActivities, getRecentActivitiesPaginated, compactRequestLogs,
    getCatFoodLogCount, getCatFoodLogs,
    getOrCreateCurrentMarket, getCurrentQuote, getCatCanDayChange, ensureCurrentCatCanPrice,
    ensureCatCanIndexes, ensureCatCanPool, buyCatCans, sellCatCans, adjustCatCans, calibrateCatCanPool,
    getCatCanPage,
    CAT_CAN_ADMIN_ADJUSTMENT_MAX,
    ensureCatAccountIndexes, formatCatFood, getCatAccountPage, grantCatFood,
    createCatFoodBatchPreview, getCatFoodBatchPreview, confirmCatFoodBatchPreview,
    reverseCatCanTransaction, purgeUnverifiedCatAssets,
    ensureCatMapIndexes, joinCatMapPlayer, getCatMapSnapshot,
    moveCatMapPlayer, setCatMapCellColor, adminPaintCatMap, adminRelocateCatMapPlayer,
    refreshCatMapTerritories, recountSchoolCatTerritories, getCatMapCooldownMinutes,
    getCatMapConfig, saveCatMapConfig, getCatMapPlan, getCatMapPlanView,
    saveCatMapPlan, stopCatMapPlan, advanceCatMapPlan, runCatMapPlansDue,
    buildCatMapPlanView, validateCatMapPlanShape, normalizeCatMapPlanMaxSteps,
    CAT_MAP_PLAN_MAX_STEPS_DEFAULT, CAT_MAP_PLAN_MAX_STEPS_LIMIT, CAT_MAP_PLAN_RETRY_LIMIT,
    ensureSchoolCatIndexes, searchSchools, listSchools, getSchool, getSchoolView,
    getBigCatWorldState, getSchoolCatRanking, bindSchoolCat, unbindSchoolCat, feedSchoolCat, getSchoolCatDetail,
    setSchoolCatTerritoryColor, schoolCatKey, schoolIdFromCatKey,
    createSpecialSchoolCat, renameSpecialSchoolCat, listSpecialSchoolCats, transferSchoolCat,
    isAdminSchoolCatRecord, backfillSchoolCatMoveContributions,
    getSchoolCatWeeklyRewardStatus, listSchoolCatWeeklyRewards,
    getSchoolCatWeeklyRewardDetail, getSchoolCatWeeklyRewardRollbackCheck,
    settleSchoolCatWeeklyRewards, rollbackSchoolCatWeeklyRewards,
    schoolCatRewardPeriod, schoolCatTerritoryBaseReward,
    schoolCatColorCss, schoolDisplay, schoolUrl, removeSchoolCatBinding,
    submitRequest, directUpdate, approveRequest, rejectRequest,
    getPendingRequests, getPendingRequestCount, getRequestById, getRequestsByIds, getUserPendingRequests,
    applyRequestPayload,
    createToken, getTokensByUid, getAllActiveTokens, getTokenByHash, deleteToken, touchToken,
    createClient, getClients, getClient, deleteClient, verifyClientSecret,
    redirectAllowed, createCode, consumeCode,
    createAccessToken, getAccessTokenByRaw, refreshAccessToken, revokeToken, revokeAllForClient,
    logDeny, DEFAULT_SCOPES,
    wikiAdd, wikiImport, wikiEdit, wikiGet, wikiGetApproved, wikiGetOrCreateIndex,
    wikiDelete,
    wikiCatGetAll, wikiCatAdd, wikiCatEdit, wikiCatDelete,
    aiGetRecordDetail, aiIsContestRecord,
    aiGetAnalysis, aiSaveAnalysis, aiDeleteAnalysis,
    aiGetProblemSummary, aiSaveProblemSummary, aiSaveProblemDifficulty,
    aiBatchGetStatus, aiBatchSaveStatus,
    aiGetAccess, aiGetAccessList, aiSetAccess, aiAddQuota, aiRemoveAccess, aiDeductBalance,
    aiGetProviders, aiSaveProvider, aiDeleteProvider,
    aiUpsertProviderModel, aiDeleteProviderModel, aiResolveModel,
    aiAddUsage, aiGetUsageStats, aiGetUsedMap,
    aiGetConfig, aiSaveConfig,
    ensureModerationIndexes, modAdd, modCloseMissingTarget, modGet, modListPending,
    modListRecent, modSetStatus, modExpireEntries,
    modFindCachedVerdict, modCountTodayByUid, modTodayCost, modStats,
    ensureMeowIndexes, meowDateKey, meowDailyFreeAvailable,
    meowGetPost, meowLastPost, meowCooldownAnchorPost, meowCooldownRemaining, meowCooldownText, meowRefundCan,
    meowPostAdd, meowMedalPostAdd, meowFeed, meowUserPosts,
    meowResolveVerdict, meowForwardCount, meowListPending, meowListRecent, meowListAll, meowDelete, meowTodayStats, meowSetStatus,
    meowFollow, meowUnfollow, meowIsFollowing,
    meowFollowingList, meowFollowerList, meowFollowingCount, meowFollowerCount,
    meowFollowingMap, meowFollowedByMap,
    meowToggleLike, meowLikedMap,
    setMeowReviewKicker, meowAdminUids, meowHomeFeed, meowBuildChain,
    MEOW_POST_CAN_COST, MEOW_POST_COOLDOWN_MS,
    ensureMedalIndexes, medalGet, medalList, medalCatalogue, medalSave,
    medalDelete, medalGetUserAwards, medalListRecentAwards, medalAwardStats,
    medalGrant, medalRevoke, medalEvaluateUser, medalEvaluateAll, medalSetLevel,
    medalCategoryOf, medalCategoryName, medalCategoryRank, medalGroupByCategory,
    medalLevelOf, medalDisplayRung, medalSortedLevels, medalAwardView,
    medalIsLevelSeries, medalThresholdLevel, medalAutomaticRuleText,
    medalMigrateAutomaticLevels,
    MEDAL_CATEGORIES, MEDAL_CATEGORY_NAMES, MEDAL_AUTOMATIC_SERIES, AUTOMATIC_RULE_TYPES,
    medalGetAcceptedDomains, medalSetAcceptedDomains,
    medalAcceptedDomainIncluded, medalImportInitialDefinitions,
    ensureAuctionIndexes, auctionGet, auctionCreate, auctionBid, auctionSettle,
    auctionSettleExpired, auctionCancel, auctionListActive, auctionListRecentFinished,
    auctionGetBids, auctionSaleableShowcase,
    ensureContractIndexes, contractGet, contractListSellableAwards, contractCreate,
    contractAccept, contractDecline, contractCancel, contractListIncoming,
    contractListOutgoing, contractListRecentResolved,
    CONTRACT_FEE_PERCENT, contractFeeAmount,
    ensureAlgorithmIndexes, algorithmGetConfig, algorithmSaveConfig,
    algorithmListItems, algorithmGetItem, algorithmCountItems,
    algorithmGroupItems, algorithmComputeStats,
    algorithmProfileView, algorithmSetLevels,
    algorithmMonthKey, algorithmNextUpdateDate,
    algorithmGetSelfQuota, algorithmClaimSelfQuota, algorithmReleaseSelfQuota, algorithmResetSelfQuota,
    algorithmSaveItem, algorithmDeleteItem, algorithmSetItemEnabled, algorithmBulkSetEnabled,
    algorithmImportOutline, algorithmEnsureOutlineImported, algorithmMigrateOutlineIds,
    algorithmOutlineData, algorithmOutlineMeta, normalizeOutlineId,
    algorithmNormalizeLevel, algorithmLevelName,
    ALGORITHM_LEVELS, ALGORITHM_LEVEL_NAMES, ALGORITHM_MAX_LEVEL,
    ALGORITHM_MAX_TEXT, ALGORITHM_MAX_NOTE, ALGORITHM_MAX_GROUP_NAME, ALGORITHM_MAX_ITEMS,
    ALGORITHM_CONFIG_ID,
};

global.Hydro.model.oi33 = oi33Model;

declare module 'hydrooj' {
    interface Model {
        oi33: typeof oi33Model;
    }
    interface Collections {
        oi33_user: import('./types').Oi33User;
        oi33_coin_bill: import('./types').Oi33CoinBill;
        oi33_paste: import('./types').Oi33Paste;
        oi33_token: import('./types').Oi33Token;
        oi33_log: import('./types').Oi33Log;
        oi33_request: import('./types').Oi33Request;
        oi33_oauth_client: import('./types').Oi33OAuthClient;
        oi33_oauth_code: import('./types').Oi33OAuthCode;
        oi33_oauth_token: import('./types').Oi33OAuthToken;
        oi33_oauth_refresh: import('./types').Oi33OAuthRefreshToken;
        oi33_cat_can_bill: import('./types').Oi33CatCanBill;
        oi33_cat_can_pool: import('./types').Oi33CatCanPool;
        oi33_cat_can_price: import('./types').Oi33CatCanPrice;
        oi33_cat_food_batch_preview: import('./types').Oi33CatFoodBatchPreview;
        oi33_cat_map_player: import('./types').Oi33CatMapPlayer;
        oi33_cat_map_cell: import('./types').Oi33CatMapCell;
        oi33_cat_map_plan: import('./types').Oi33CatMapPlan;
        oi33_cat_map_config: import('./types').Oi33CatMapConfig;
        oi33_school_cat: import('./types').Oi33SchoolCat;
        oi33_school_feed_history: import('./types').Oi33SchoolFeedHistory;
        oi33_school_cat_reward: import('./types').Oi33SchoolCatReward;
        oi33_ai_analysis: import('./types').Oi33AiAnalysis;
        oi33_ai_config: import('./types').Oi33AiConfig;
        oi33_ai_problem_summary: import('./types').Oi33AiProblemSummary;
        oi33_ai_provider: import('./types').Oi33AiProvider;
        oi33_ai_access: import('./types').Oi33AiAccess;
        oi33_ai_usage: import('./types').Oi33AiUsage;
        oi33_ai_moderation: import('./types').Oi33AiModeration;
        oi33_meow_post: import('./types').Oi33MeowPost;
        oi33_meow_follow: import('./types').Oi33MeowFollow;
        oi33_meow_like: import('./types').Oi33MeowLike;
        oi33_medal: import('./types').Oi33Medal;
        oi33_user_medal: import('./types').Oi33UserMedal;
        oi33_auction: import('./types').Oi33Auction;
        oi33_auction_bid: import('./types').Oi33AuctionBid;
        oi33_medal_contract: import('./types').Oi33Contract;
        oi33_algorithm_item: import('./types').Oi33AlgorithmItem;
        oi33_user_algorithm: import('./types').Oi33UserAlgorithm;
        oi33_algorithm_config: import('./types').Oi33AlgorithmConfig;
    }
}

export { oi33Model };
