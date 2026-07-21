import {
    getUserDataByUids, mergeOi33Fields, anonymizeOi33Identity,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
    previewCatFoodBackfill, backfillCatFoodForUser, backfillAllCatFood,
    getAllUsersData, getRatedUsers,
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
    getOrCreateCurrentMarket, getCurrentQuote, ensureCurrentCatCanPrice,
    ensureCatCanIndexes, buyCatCans, sellCatCans, getCatCanPage,
} from './cat-can';
import {
    ensureCatAccountIndexes, formatCatFood, getCatAccountPage, grantCatFood,
    createCatFoodBatchPreview, getCatFoodBatchPreview, confirmCatFoodBatchPreview,
    reverseCatCanTransaction,
} from './cat-account';
import {
    ensureCatMapIndexes, joinCatMapPlayer, getCatMapSnapshot,
    moveCatMapPlayer, setCatMapCellColor, adminPaintCatMap, adminRelocateCatMapPlayer,
    getCatMapCooldownMinutes,
} from './cat-map';

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
export { catMapPlayerColl, catMapCellColl } from './cat-map';

const oi33Model = {
    getUserDataByUids, mergeOi33Fields, anonymizeOi33Identity,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
    previewCatFoodBackfill, backfillCatFoodForUser, backfillAllCatFood,
    pasteAdd, pasteEdit, pasteGet, pasteDel, pasteCountUser, pasteGetUser,
    getAllUsersData, getRatedUsers, getRecentActivities, getRecentActivitiesPaginated, compactRequestLogs,
    getCatFoodLogCount, getCatFoodLogs,
    getOrCreateCurrentMarket, getCurrentQuote, ensureCurrentCatCanPrice,
    ensureCatCanIndexes, buyCatCans, sellCatCans, getCatCanPage,
    ensureCatAccountIndexes, formatCatFood, getCatAccountPage, grantCatFood,
    createCatFoodBatchPreview, getCatFoodBatchPreview, confirmCatFoodBatchPreview,
    reverseCatCanTransaction,
    ensureCatMapIndexes, joinCatMapPlayer, getCatMapSnapshot,
    moveCatMapPlayer, setCatMapCellColor, adminPaintCatMap, adminRelocateCatMapPlayer,
    getCatMapCooldownMinutes,
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
    }
}

export { oi33Model };
