import { Context, PRIV } from 'hydrooj';
import {
    Ai33AccessHandler, Ai33AdminHandler, Ai33BalanceHandler, Ai33ModelsHandler,
} from './admin';
import {
    Ai33AnalysisDeleteHandler, Ai33AnalysisGetHandler, Ai33AnalyzePageHandler,
    Ai33AnalyzeStreamHandler, Ai33CanAnalyzeHandler,
} from './analyze';
import {
    Ai33SummaryBatchHandler, Ai33SummaryHandler, Ai33SummaryStreamHandler,
} from './summary';

export async function apply(ctx: Context) {
    ctx.Route('oi33_ai_admin', '/oi33/ai/admin', Ai33AdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_access', '/oi33/ai/access', Ai33AccessHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_models', '/oi33/ai/models', Ai33ModelsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_summary', '/oi33/ai/summary', Ai33SummaryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_summary_batch', '/oi33/ai/summary/batch', Ai33SummaryBatchHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_analyze_page', '/oi33/ai/analyze/:rid', Ai33AnalyzePageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('oi33_ai_summary_stream', '/oi33/ai/summary-stream', Ai33SummaryStreamHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('oi33_ai_analyze_stream', '/oi33/ai/analyze-stream/:rid', Ai33AnalyzeStreamHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_can_analyze', '/oi33/ai/can-analyze', Ai33CanAnalyzeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_analysis_get', '/oi33/ai/analysis/:rid', Ai33AnalysisGetHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_analysis_delete', '/oi33/ai/analysis/:rid/delete', Ai33AnalysisDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_balance', '/oi33/ai/balance', Ai33BalanceHandler, PRIV.PRIV_USER_PROFILE);
}
