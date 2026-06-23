import {
    getUserDataByUids, mergeOi33Fields,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
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
} from './log';

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

const oi33Model = {
    getUserDataByUids, mergeOi33Fields,
    coinInc, coinBillCount, coinGetAll, coinUserBillCount, coinGetUser, coinGetLeaderboard,
    setBirthday, getTodayBirthdays, getAllBirthdays, getBirthdayCount, getRecentBirthdays,
    setBadge, getBadgedUsers, removeBadge,
    setRealname, getRealnamedUsers,
    doCheckin, getCheckinUser,
    pasteAdd, pasteEdit, pasteGet, pasteDel, pasteCountUser, pasteGetUser,
    getAllUsersData, getRatedUsers, getRecentActivities, getRecentActivitiesPaginated, compactRequestLogs,
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
    }
}

export { oi33Model };
