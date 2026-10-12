import {
    ConnectionHandler, ForbiddenError, Handler, NotFoundError, Types, param, query,
} from 'hydrooj';
import { oi33Model } from '../../model';
import { aiChatStream, aiResolveChatConfig } from '../../model/ai';
import {
    STATUS_NAMES, buildPrompts, contestBlockReason, formatMoney, getAccessState, isTeacherUser, optimizeProblemContent,
} from './prompts';
import { generateProblemSummary } from './summary';

// Problems whose summary is currently being generated in the background.
const summaryInFlight = new Set<string>();
const DIRECT_ANALYSIS_ENABLED = true;

// --- AI analyze page (GET) ---

export class Ai33AnalyzePageHandler extends Handler {
    @param('rid', Types.String)
    async get(_domainId: string, rid: string) {
        const rdoc = await oi33Model.aiGetRecordDetail(rid);
        if (!rdoc) throw new NotFoundError(rid);
        const access = await getAccessState(this.user._id);
        if (rdoc.uid !== this.user._id && !access.isTeacher) throw new NotFoundError(rid);

        const blockReason = contestBlockReason(rdoc, access.isTeacher);
        if (blockReason) {
            this.response.template = 'oi33_ai_analyze.html';
            this.response.body = { error: 'contest', rid, contestMessage: blockReason };
            return;
        }

        if (!access.allowed) {
            this.response.template = 'oi33_ai_analyze.html';
            this.response.body = { error: 'no_access', rid };
            return;
        }

        if (DIRECT_ANALYSIS_ENABLED && !access.unlimited && !access.isTeacher && access.balance <= 0) {
            this.response.template = 'oi33_ai_analyze.html';
            this.response.body = { error: 'no_balance', rid, access, balanceText: formatMoney(access.balance) };
            return;
        }

        const [pdoc, existingAnalysis, summary, aiCfg] = await Promise.all([
            global.Hydro.model.problem.get(rdoc.domainId, rdoc.pid).catch(() => null),
            oi33Model.aiGetAnalysis(rid),
            oi33Model.aiGetProblemSummary(rdoc.domainId, rdoc.pid),
            oi33Model.aiGetConfig(),
        ]);

        const langConfig = (global.Hydro as any).model?.setting?.langs?.[rdoc.lang]
            || (global.Hydro as any).langs?.[rdoc.lang];
        const languageName = langConfig?.display || rdoc.lang;

        const brief = summary?.content
            || (pdoc ? [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n') : '(题目信息无法获取)');
        const { systemPrompt, userPrompt } = buildPrompts(rdoc, brief, access.isTeacher, languageName, aiCfg);
        const aiPrompt = `【System Prompt】\n${systemPrompt}\n\n【User Prompt】\n${userPrompt}`;

        this.response.template = 'oi33_ai_analyze.html';
        this.response.body = {
            rid,
            code: rdoc.code,
            language: languageName,
            pid: rdoc.pid,
            domainId: rdoc.domainId,
            problemTitle: pdoc?.title || `P${rdoc.pid}`,
            statusText: STATUS_NAMES[rdoc.status] || `Status ${rdoc.status}`,
            score: rdoc.score,
            time: rdoc.time,
            memory: rdoc.memory,
            testCases: rdoc.testCases || [],
            isTeacher: access.isTeacher,
            unlimited: access.unlimited,
            balance: access.balance,
            balanceText: access.unlimited || access.isTeacher ? '' : formatMoney(access.balance),
            aiPrompt,
            directAnalysisEnabled: DIRECT_ANALYSIS_ENABLED,
            existingAnalysis: existingAnalysis?.suggestion || null,
        };
    }
}

// --- Saved analysis get/delete ---

export class Ai33AnalysisGetHandler extends Handler {
    async get() {
        const rid = this.request.params.rid;
        const [rdoc, isTeacher] = await Promise.all([
            oi33Model.aiGetRecordDetail(rid),
            isTeacherUser(this.user._id),
        ]);
        if (!rdoc || (rdoc.uid !== this.user._id && !isTeacher)) {
            this.response.body = { suggestion: null };
            return;
        }
        const doc = await oi33Model.aiGetAnalysis(rid);
        this.response.body = { suggestion: doc ? doc.suggestion : null };
    }
}

export class Ai33AnalysisDeleteHandler extends Handler {
    async post() {
        // Only teachers may clear a saved analysis (this re-enables the
        // student's re-analysis).
        if (!await isTeacherUser(this.user._id)) throw new ForbiddenError('仅老师可以清除分析结果。');
        const rid = this.request.params.rid;
        await oi33Model.aiDeleteAnalysis(rid);
        this.response.body = { success: true };
    }
}

export class Ai33CanAnalyzeHandler extends Handler {
    @query('rid', Types.String, true)
    async get(_domainId: string, rid?: string) {
        const [access, rdoc] = await Promise.all([
            getAccessState(this.user._id),
            rid ? oi33Model.aiGetRecordDetail(rid) : null,
        ]);
        const blockReason = rdoc ? contestBlockReason(rdoc, access.isTeacher) : null;
        const canAnalyze = DIRECT_ANALYSIS_ENABLED && !blockReason && access.allowed;
        this.response.body = {
            canAnalyze,
            isTeacher: access.isTeacher,
            unlimited: access.unlimited,
            balance: access.balance,
            isContest: !!blockReason,
            directAnalysisEnabled: DIRECT_ANALYSIS_ENABLED,
            message: blockReason || undefined,
        };
    }
}

// --- AI analyze stream handler (WebSocket) ---

// Bound concurrent AI calls for stability/cost: excess users wait in a queue
// and see a "排队中" status with their position.
const MAX_CONCURRENT_ANALYSES = 3;
let runningAnalyses = 0;
const analysisWaiters: Array<{ handler: Ai33AnalyzeStreamHandler; grant: () => void }> = [];

function notifyQueuePositions() {
    analysisWaiters.forEach((w, i) => {
        try {
            w.handler.send({ status: 'queued', position: i + 1 });
        } catch { /* connection may be gone */ }
    });
}

async function acquireAnalysisSlot(handler: Ai33AnalyzeStreamHandler): Promise<boolean> {
    if (runningAnalyses < MAX_CONCURRENT_ANALYSES) {
        runningAnalyses++;
        return true;
    }
    handler.send({ status: 'queued', position: analysisWaiters.length + 1 });
    return await new Promise<boolean>((resolve) => {
        const waiter = { handler, grant: () => resolve(true) };
        analysisWaiters.push(waiter);
        handler.conn.on('close', () => {
            const i = analysisWaiters.indexOf(waiter);
            if (i >= 0) {
                analysisWaiters.splice(i, 1);
                notifyQueuePositions();
                resolve(false);
            }
        });
    });
}

function releaseAnalysisSlot() {
    const next = analysisWaiters.shift();
    // Hand the slot directly to the next waiter; only decrement when empty.
    if (next) next.grant();
    else runningAnalyses--;
    notifyQueuePositions();
}

export class Ai33AnalyzeStreamHandler extends ConnectionHandler {
    @param('rid', Types.String)
    async prepare(_domainId: string, rid: string) {
        const t0 = Date.now();
        const [rdoc, access, existingAnalysis] = await Promise.all([
            oi33Model.aiGetRecordDetail(rid),
            getAccessState(this.user._id),
            oi33Model.aiGetAnalysis(rid),
        ]);

        if (!rdoc || (rdoc.uid !== this.user._id && !access.isTeacher)) {
            this.send({ error: 'Record not found' });
            this.close(4000, 'Not found');
            return;
        }

        if (!DIRECT_ANALYSIS_ENABLED) {
            this.send({ error: '直接分析暂时关闭，请稍后再试。' });
            this.close(4000, 'Analysis disabled');
            return;
        }

        const streamBlockReason = contestBlockReason(rdoc, access.isTeacher);
        if (streamBlockReason) {
            this.send({ error: streamBlockReason });
            this.close(4000, 'Contest');
            return;
        }

        if (!access.allowed) {
            this.send({ error: '你还没有 AI 分析权限，请联系老师开通。' });
            this.close(4000, 'No access');
            return;
        }

        if (!access.unlimited && !access.isTeacher && access.balance <= 0) {
            this.send({ error: 'AI 分析余额不足，请联系老师充值。' });
            this.close(4000, 'No balance');
            return;
        }

        // A completed analysis is final for students: only a teacher clearing
        // it unlocks re-analysis.
        if (existingAnalysis && !access.isTeacher) {
            this.send({ error: '本题已有完成的分析，如需重新分析请联系老师清除。' });
            this.close(4000, 'Already analyzed');
            return;
        }

        const cfgPromise = oi33Model.aiGetConfig();
        // Kick off problem + summary-cache lookups in parallel with config
        // resolution to cut time-to-first-token.
        const pdocPromise = global.Hydro.model.problem.get(rdoc.domainId, rdoc.pid).catch(() => null);
        const cachedPromise = oi33Model.aiGetProblemSummary(rdoc.domainId, rdoc.pid);
        const cfg = await cfgPromise;
        const config = await aiResolveChatConfig(access.isTeacher ? cfg.teacher_model : cfg.student_model);
        if (!config.apiKey) {
            this.send({ error: `未配置 AI API Key（模型 ${config.model}），请到 /oi33/ai/models 检查 Provider 配置。` });
            this.close(4000, 'No API key');
            return;
        }

        const [pdoc, cached] = await Promise.all([pdocPromise, cachedPromise]);

        // Condensed statement: reuse the cache when present. On first use,
        // don't block the analysis on summary generation — analyze with the
        // full statement now and build the cache in the background.
        let brief = '';
        if (pdoc) {
            if (cached?.content) {
                brief = cached.content;
            } else {
                brief = [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n');
                const key = `${rdoc.domainId}:${rdoc.pid}`;
                if (!summaryInFlight.has(key)) {
                    summaryInFlight.add(key);
                    generateProblemSummary(rdoc.domainId, rdoc.pid, brief, cfg.summary_model)
                        .catch(() => {})
                        .finally(() => summaryInFlight.delete(key));
                }
            }
        }
        if (!brief) brief = '(题目信息无法获取)';

        const { resultsText, systemPrompt, userPrompt } = buildPrompts(rdoc, brief, access.isTeacher, rdoc.lang || '未知', cfg);

        const acquired = await acquireAnalysisSlot(this);
        if (!acquired) return; // disconnected while queued

        // DeepSeek thinking mode defaults to effort=high; admins can lower it
        // per role via /oi33/ai/models. analysis_effort is the legacy global
        // field.
        const effort = (access.isTeacher ? cfg.teacher_effort : cfg.student_effort) || cfg.analysis_effort;

        this.send({ status: 'analyzing' });
        const tFetch = Date.now();
        let firstChunkAt = 0;
        const markFirstChunk = () => {
            if (firstChunkAt) return;
            firstChunkAt = Date.now();
            console.info(`[ai33] analyze ${rid}: model=${config.model} provider=${config.provider || 'env'}, prep=${tFetch - t0}ms, ttft=${firstChunkAt - tFetch}ms`);
        };

        try {
            const response = await aiChatStream({
                config,
                system: systemPrompt,
                user: userPrompt,
                // Reasoning-style models burn completion tokens on thinking;
                // keep the cap well above the ~500-char answer so long
                // reasoning on hard problems isn't truncated.
                maxTokens: 16384,
                effort,
                // Reasoning models stream reasoning_content long before
                // content; forward it so the user sees progress immediately.
                onChunk: (text) => { markFirstChunk(); this.send({ chunk: text }); },
                onRChunk: (text) => { markFirstChunk(); this.send({ rchunk: text }); },
            });
            const { content: fullText, usage, error } = response;

            if (error || !fullText) {
                this.send({ error: error ? `AI ${error}` : 'No response from AI.' });
                this.close(4000, error ? 'API error' : 'Empty response');
                return;
            }

            const cost = response.cost;
            // Teachers and unlimited accounts are never charged; usage is still logged.
            const shouldCharge = !access.isTeacher && !access.unlimited;
            if (shouldCharge && cost > 0) {
                await oi33Model.aiDeductBalance(this.user._id, cost);
            }
            await oi33Model.aiAddUsage({
                uid: this.user._id,
                type: 'analysis',
                rid,
                domainId: rdoc.domainId,
                pid: rdoc.pid,
                provider: config.provider,
                model: config.model,
                promptTokens: usage?.prompt_tokens || 0,
                completionTokens: usage?.completion_tokens || 0,
                cacheHitTokens: usage?.prompt_cache_hit_tokens || 0,
                cost,
                deducted: shouldCharge && cost > 0,
            });

            this.send({ status: 'saving' });

            await oi33Model.aiSaveAnalysis({
                rid,
                userId: this.user._id,
                problem: pdoc?.title || '',
                results: resultsText,
                code: rdoc.code,
                language: rdoc.lang || '',
                suggestion: fullText,
            });

            let costText = '';
            let newBalanceText = '';
            if (cost > 0) {
                costText = shouldCharge
                    ? `本次消耗 ${formatMoney(cost)}，余额 ${formatMoney(Math.max(0, access.balance - cost))}`
                    : `本次消耗 ${formatMoney(cost)}（不计费）`;
                if (shouldCharge) newBalanceText = formatMoney(Math.max(0, access.balance - cost));
            }
            this.send({ done: true, fullText, costText, balanceText: newBalanceText });
        } catch (e: any) {
            const errorMsg = e.name === 'AbortError' ? 'Request timed out' : e.message;
            this.send({ error: `Request failed: ${errorMsg}` });
        } finally {
            releaseAnalysisSlot();
        }
    }
}
