// OI33 model barrel. Each module is imported as a namespace and spread into
// `oi33Model`, so adding an export to a model file is picked up automatically
// instead of having to be listed twice (import list + object literal).
import * as userModel from './user';
import * as pasteModel from './paste';
import * as wikiModel from './wiki';
import * as requestModel from './request';
import * as oauthModel from './oauth';
// Spread after oauth: both export `tokenColl` (oauth's own token collection);
// the barrel's named `oauthTokenColl` export disambiguates them.
import * as tokenModel from './token';
import * as logModel from './log';
import * as catCanModel from './cat-can';
import * as catAccountModel from './cat-account';
import * as catMapModel from './cat-map';
import * as catMapPlanModel from './cat-map-plan';
import * as schoolCatModel from './school-cat';
import * as aiModel from './ai';
import * as moderateModel from './moderate';
import * as meowModel from './meow';
import * as medalModel from './medal';
import * as auctionModel from './auction';
import * as contractModel from './contract';
import * as algorithmModel from './algorithm';

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
    ...userModel,
    ...pasteModel,
    ...wikiModel,
    ...requestModel,
    ...oauthModel,
    ...tokenModel,
    ...logModel,
    ...catCanModel,
    ...catAccountModel,
    ...catMapModel,
    ...catMapPlanModel,
    ...schoolCatModel,
    ...aiModel,
    ...moderateModel,
    ...meowModel,
    ...medalModel,
    ...auctionModel,
    ...contractModel,
    ...algorithmModel,
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
        oi33_wiki: import('./types').Oi33Wiki;
        oi33_wiki_category: import('./types').Oi33WikiCategoryDoc;
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
        oi33_ai_batch: import('./types').Oi33AiBatchStatus;
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
