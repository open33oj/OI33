import {
    ConnectionHandler, Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, UserModel,
    param, query,
} from 'hydrooj';
import { oi33Model } from '../model';
import type { Oi33AiProviderModel } from '../model/types';
import { checkOi33Admin, checkUserFlag } from './utils';

const DEFAULT_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEFAULT_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
// Manual "regenerate summary" always uses this model (better quality, runs rarely).
const SUMMARY_PRO_MODEL = 'deepseek-v4-pro';
// Problems whose summary is currently being generated in the background.
const summaryInFlight = new Set<string>();
const DIRECT_ANALYSIS_ENABLED = true;

const STATUS_NAMES: Record<number, string> = {
    0: 'Pending',
    1: 'Accepted',
    2: 'Wrong Answer',
    3: 'Time Limit Exceeded',
    4: 'Memory Limit Exceeded',
    5: 'Output Limit Exceeded',
    6: 'Runtime Error',
    7: 'Compile Error',
    8: 'System Error',
    9: 'Canceled',
};

const DEFAULT_STUDENT_SYSTEM_PROMPT = [
    '你是 OI/NOIP 算法竞赛教练，正在指导小学生分析自己的代码。',
    '输入包含：精简题意、评测状态、测试点通过情况汇总、代码。',
    '要求：',
    '1. 先判断整体思路是否可行，再定位具体错误（行号、变量名）。',
    '2. 只引导不给答案：用提问和提示代替直接陈述，禁止给出完整代码或题解。',
    '3. 结合测试点汇总说明问题（如大量 TLE 说明复杂度过高）。',
    '4. 语气鼓励，控制在 300 字以内。',
].join('\n');

const DEFAULT_TEACHER_SYSTEM_PROMPT = [
    '你是算法竞赛辅导专家，帮助 OI 教练分析学生代码。',
    '输入包含：精简题意、评测状态、测试点通过情况汇总、代码。',
    '要求：',
    '1. 先给结论：思路/算法是否可行（复杂度是否满足数据范围）。',
    '2. 再定位：具体行号、变量、错误原因，结合测试点汇总佐证。',
    '3. 给出修改方向，但不要重写完整代码。',
    '4. 控制在 500 字以内。',
].join('\n');

const SUMMARY_SYSTEM_PROMPT = [
    '你是信息学竞赛题目整理助手。请把题目描述压缩为「精简题意」，供 AI 分析代码时快速理解题目。',
    '规则：',
    '1. 保留：问题的精确定义、输入格式、输出格式、数据范围与约束、需要特判的情况。',
    '2. 完整优先于简短：题目涉及的规则、映射关系、边界条件必须一条不漏地列全（例如猜拳题中每种手势的胜负关系都要写全）。',
    '3. 删除：背景故事、样例及样例解释、提示与备注、来源信息。',
    '4. 数学符号和变量名保持原样（保留 $...$ LaTeX）。',
    '5. 直接输出精简后的题意（markdown），不要任何额外评论。一般控制在 600 字以内，但以不遗漏关键信息为前提。',
].join('\n');

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function optimizeProblemContent(html: string): string {
    const text = stripHtml(html);
    try {
        const obj = JSON.parse(text);
        if (obj.zh && typeof obj.zh === 'string') return obj.zh;
        if (obj.en && typeof obj.en === 'string') return obj.en;
    } catch {}
    return text;
}

// Compact aggregate instead of per-testcase lines: keeps the prompt small.
function formatTestResults(testCases: any[], status: number, score: number): string {
    if (!testCases || testCases.length === 0) {
        return `评测结果：${STATUS_NAMES[status] || status}（无测试点明细）`;
    }
    const counts: Record<string, number> = {};
    for (const tc of testCases) {
        const name = STATUS_NAMES[tc.status] || `S${tc.status}`;
        counts[name] = (counts[name] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(', ');
    return `共 ${testCases.length} 个测试点：${summary}`;
}

function optimizeCode(code: string): string {
    return code.replace(/\n{3,}/g, '\n\n').trim();
}

// realname_flag: 1 = student, 2 = teacher, 3 = admin. Teachers (and above)
// get unlimited quota (usage still recorded) and the teacher prompt.
async function isTeacherUser(uid: number): Promise<boolean> {
    return (await checkUserFlag(uid)) >= 2;
}

function isContestId(contest: any): boolean {
    if (!contest) return false;
    const hex = typeof contest.toHexString === 'function' ? contest.toHexString() : String(contest);
    return !hex.startsWith('0'.repeat(23));
}

// Contest/homework submissions are never AI-analyzable by students, even
// after the contest ends; teachers can analyze anyone's code at any time.
function contestBlockReason(rdoc: any, isTeacher: boolean): string | null {
    if (!isContestId(rdoc.contest) || isTeacher) return null;
    return '比赛提交仅老师可以使用 AI 分析。';
}

interface ChatConfig {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    price: Oi33AiProviderModel | null;
}

// Resolve a model name against the provider list; fall back to env/legacy
// defaults (no pricing → cost recorded as 0) so a bare env-key setup still works.
async function resolveChatConfig(modelName: string): Promise<ChatConfig> {
    const resolved = await oi33Model.aiResolveModel(modelName);
    if (resolved) return { ...resolved, model: modelName };
    return {
        provider: '',
        baseUrl: DEFAULT_BASE_URL,
        apiKey: DEFAULT_API_KEY,
        model: modelName,
        price: null,
    };
}

function calcCost(usage: any, price: Oi33AiProviderModel | null): number {
    if (!usage || !price) return 0;
    const hit = usage.prompt_cache_hit_tokens || 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
    const output = usage.completion_tokens || 0;
    return (miss * price.input + hit * (price.inputCached ?? price.input) + output * price.output) / 1e6;
}

function formatMoney(v: number): string {
    return `¥${v.toFixed(4)}`;
}

async function callChatCompletion(config: ChatConfig, systemPrompt: string, userPrompt: string, maxTokens = 1024) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const resp = await fetch(`${config.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                max_tokens: maxTokens,
                temperature: 0.3,
            }),
            signal: controller.signal,
        });
        if (!resp.ok) return { content: '', usage: null, finishReason: '', error: `API error (${resp.status}): ${await resp.text()}` };
        const data = await resp.json();
        return {
            content: data.choices?.[0]?.message?.content?.trim() || '',
            usage: data.usage || null,
            finishReason: data.choices?.[0]?.finish_reason || '',
            error: '',
        };
    } catch (e: any) {
        return { content: '', usage: null, finishReason: '', error: e.name === 'AbortError' ? 'Request timed out' : e.message };
    } finally {
        clearTimeout(timer);
    }
}

// Generate (or regenerate) the condensed statement for a problem and record the
// cost globally (never charged to a user). Returns the summary text or ''.
async function generateProblemSummary(
    domainId: string, pid: number, fullText: string, modelName: string,
): Promise<string> {
    const config = await resolveChatConfig(modelName);
    if (!config.apiKey) return '';
    // Generous budget: reasoning-style models burn completion tokens on
    // thinking, and LaTeX-heavy summaries are token-dense.
    const { content, usage, finishReason } = await callChatCompletion(config, SUMMARY_SYSTEM_PROMPT, fullText, 4096);
    if (!content) return '';
    // Never cache a truncated summary.
    if (finishReason === 'length') return '';
    await oi33Model.aiSaveProblemSummary(domainId, pid, content, config.model);
    await oi33Model.aiAddUsage({
        uid: 0,
        type: 'summary',
        domainId,
        pid,
        provider: config.provider,
        model: config.model,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
        cacheHitTokens: usage?.prompt_cache_hit_tokens || 0,
        cost: calcCost(usage, config.price),
        deducted: false,
    });
    return content;
}

function buildPrompts(rdoc: any, brief: string, isTeacher: boolean, langDisplay: string) {
    const statusName = STATUS_NAMES[rdoc.status] || `Status ${rdoc.status}`;
    const resultsText = formatTestResults(rdoc.testCases || [], rdoc.status, rdoc.score);
    const systemPrompt = isTeacher ? DEFAULT_TEACHER_SYSTEM_PROMPT : DEFAULT_STUDENT_SYSTEM_PROMPT;
    const userPrompt = [
        '## 题意',
        brief,
        '',
        '## 评测状态',
        `Status: ${statusName}, Score: ${rdoc.score}, Time: ${rdoc.time}ms, Memory: ${rdoc.memory}KB, Lang: ${langDisplay}`,
        '',
        '## 测试点汇总',
        resultsText,
        '',
        '## 代码',
        '```' + (rdoc.lang || ''),
        optimizeCode(rdoc.code),
        '```',
    ].join('\n');
    return { resultsText, systemPrompt, userPrompt };
}

interface AccessState {
    isTeacher: boolean;
    allowed: boolean;
    unlimited: boolean;
    balance: number; // meaningless when unlimited/isTeacher
}

async function getAccessState(uid: number): Promise<AccessState> {
    const isTeacher = await isTeacherUser(uid);
    if (isTeacher) {
        return {
            isTeacher, allowed: true, unlimited: true, balance: 0,
        };
    }
    const acc = await oi33Model.aiGetAccess(uid);
    if (!acc) {
        return {
            isTeacher, allowed: false, unlimited: false, balance: 0,
        };
    }
    return {
        isTeacher,
        allowed: acc.unlimited || acc.balance > 0,
        unlimited: !!acc.unlimited,
        balance: acc.balance || 0,
    };
}

// --- Admin hub ---

class Ai33AdminHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const [stats, accessCount, providers, config] = await Promise.all([
            oi33Model.aiGetUsageStats(),
            oi33Model.aiGetAccessList().then((l) => l.length),
            oi33Model.aiGetProviders(),
            oi33Model.aiGetConfig(),
        ]);
        this.response.template = 'oi33_ai_admin.html';
        this.response.body = {
            stats, accessCount, providers, config, formatMoney,
        };
    }
}

// --- Access allow-list management ---

const ACCESS_PAGE_SIZE = 50;

class Ai33AccessHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async get(_d: any, page = 1) {
        await checkOi33Admin(this.user._id);
        const fullList = await oi33Model.aiGetAccessList();
        const pageCount = Math.max(1, Math.ceil(fullList.length / ACCESS_PAGE_SIZE));
        const safePage = Math.min(Math.max(1, page), pageCount);
        const list = fullList.slice((safePage - 1) * ACCESS_PAGE_SIZE, safePage * ACCESS_PAGE_SIZE);
        const uids = list.map((a) => a._id);
        const [udict, usedMap] = await Promise.all([
            uids.length ? await UserModel.getList('', uids) : {},
            oi33Model.aiGetUsedMap(uids),
        ]);
        const rows = list.map((a) => {
            const used = usedMap[a._id] || 0;
            // Legacy docs predate the granted field: fall back to balance + used.
            const granted = a.granted ?? ((a.balance || 0) + used);
            return { ...a, used, granted };
        });
        this.response.template = 'oi33_ai_access.html';
        this.response.body = {
            list: rows, udict, formatMoney,
            page: safePage, pageCount, total: fullList.length,
        };
    }

    @param('action', Types.String)
    @param('uidOrName', Types.String, true)
    @param('uid', Types.Int, true)
    @param('granted', Types.Float, true)
    @param('amount', Types.Float, true)
    @param('unlimited', Types.Boolean, true)
    async post(
        domainId: string, action: string, uidOrName?: string, uid?: number,
        granted = 0, amount = 0, unlimited = false,
    ) {
        await checkOi33Admin(this.user._id);
        if (action === 'remove' && uid) {
            await oi33Model.aiRemoveAccess(uid);
        } else if (action === 'add_quota' && uid) {
            if (amount <= 0) throw new Error('添加额度必须大于 0。');
            await oi33Model.aiAddQuota(uid, amount);
        } else if (action === 'upsert') {
            let targetUid = uid;
            if (!targetUid && uidOrName) {
                const udoc = await UserModel.getById(domainId, +uidOrName)
                    || await UserModel.getByUname(domainId, uidOrName)
                    || await UserModel.getByEmail(domainId, uidOrName);
                if (!udoc) throw new NotFoundError(uidOrName);
                targetUid = udoc._id;
            }
            if (!targetUid) throw new NotFoundError(uidOrName || uid);
            await oi33Model.aiSetAccess(targetUid, granted, unlimited);
        }
        this.response.redirect = this.url('oi33_ai_access');
    }
}

// --- Provider / model pricing management ---

class Ai33ModelsHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const [providers, config] = await Promise.all([
            oi33Model.aiGetProviders(),
            oi33Model.aiGetConfig(),
        ]);
        this.response.template = 'oi33_ai_models.html';
        this.response.body = { providers, config };
    }

    @param('action', Types.String)
    @param('provider', Types.String, true)
    @param('base_url', Types.String, true)
    @param('api_key', Types.String, true)
    @param('model', Types.String, true)
    @param('input', Types.Float, true)
    @param('input_cached', Types.Float, true)
    @param('output', Types.Float, true)
    @param('student_model', Types.String, true)
    @param('teacher_model', Types.String, true)
    @param('summary_model', Types.String, true)
    async post(
        _domainId: string, action: string,
        provider?: string, base_url?: string, api_key?: string,
        model?: string, input = 0, input_cached = 0, output = 0,
        student_model?: string, teacher_model?: string, summary_model?: string,
    ) {
        await checkOi33Admin(this.user._id);
        if (action === 'save_provider' && provider) {
            const existing = (await oi33Model.aiGetProviders()).find((p) => p._id === provider);
            if (!existing && !api_key) throw new Error('添加新 Provider 时必须填写 API Key。');
            if (existing && !existing.apiKey && !api_key) throw new Error('该 Provider 尚未配置 API Key，请填写。');
            await oi33Model.aiSaveProvider(provider, base_url || DEFAULT_BASE_URL, api_key || '');
        } else if (action === 'delete_provider' && provider) {
            await oi33Model.aiDeleteProvider(provider);
        } else if (action === 'save_model' && provider && model) {
            await oi33Model.aiUpsertProviderModel(provider, {
                name: model, input, inputCached: input_cached, output,
            });
        } else if (action === 'delete_model' && provider && model) {
            await oi33Model.aiDeleteProviderModel(provider, model);
        } else if (action === 'set_defaults') {
            await oi33Model.aiSaveConfig({
                student_model: student_model || 'deepseek-v4-flash',
                teacher_model: teacher_model || 'deepseek-v4-pro',
                summary_model: summary_model || 'deepseek-v4-flash',
            });
        }
        this.response.redirect = this.url('oi33_ai_models');
    }
}

// --- Problem summary (精简题意) view / edit / regenerate ---

class Ai33SummaryHandler extends Handler {
    @query('domainId', Types.String, true)
    @query('pid', Types.ProblemId, true)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async get(_d: any, domainId = 'system', pid?: number | string) {
        await checkOi33Admin(this.user._id);
        // Accept both numeric docId and display pid (e.g. P1000);
        // summaries are keyed by docId.
        const pdoc = pid
            ? await global.Hydro.model.problem.get(domainId, pid).catch(() => null)
            : null;
        const summary = pdoc ? await oi33Model.aiGetProblemSummary(domainId, pdoc.docId) : null;
        this.response.template = 'oi33_ai_summary.html';
        this.response.body = {
            domainId, pid: pid ?? '', pdoc, summary, proModel: SUMMARY_PRO_MODEL,
        };
    }

    @param('action', Types.String)
    @param('domainId', Types.String, true)
    @param('pid', Types.ProblemId)
    async post(_d: string, action: string, domainId = 'system', pid: number | string) {
        await checkOi33Admin(this.user._id);
        if (action === 'regenerate') {
            const pdoc = await global.Hydro.model.problem.get(domainId, pid).catch(() => null);
            if (!pdoc) throw new NotFoundError(pid);
            const fullText = [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n');
            const summary = await generateProblemSummary(domainId, pdoc.docId, fullText, SUMMARY_PRO_MODEL);
            if (!summary) throw new Error('生成失败：请检查模型配置与 API Key，或稍后再试。');
        }
        this.response.redirect = this.url('oi33_ai_summary', { query: { domainId, pid } });
    }
}

// --- AI analyze page (GET) ---

class Ai33AnalyzePageHandler extends Handler {
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

        const [pdoc, existingAnalysis, summary] = await Promise.all([
            global.Hydro.model.problem.get(rdoc.domainId, rdoc.pid).catch(() => null),
            oi33Model.aiGetAnalysis(rid),
            oi33Model.aiGetProblemSummary(rdoc.domainId, rdoc.pid),
        ]);

        const langConfig = (global.Hydro as any).model?.setting?.langs?.[rdoc.lang]
            || (global.Hydro as any).langs?.[rdoc.lang];
        const languageName = langConfig?.display || rdoc.lang;

        const brief = summary?.content
            || (pdoc ? [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n') : '(题目信息无法获取)');
        const { systemPrompt, userPrompt } = buildPrompts(rdoc, brief, access.isTeacher, languageName);
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

class Ai33AnalysisGetHandler extends Handler {
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

class Ai33AnalysisDeleteHandler extends Handler {
    async post() {
        // Only teachers may clear a saved analysis (this re-enables the
        // student's re-analysis).
        if (!await isTeacherUser(this.user._id)) throw new ForbiddenError('仅老师可以清除分析结果。');
        const rid = this.request.params.rid;
        await oi33Model.aiDeleteAnalysis(rid);
        this.response.body = { success: true };
    }
}

class Ai33CanAnalyzeHandler extends Handler {
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

// --- Balance (visible to the user themselves) ---

class Ai33BalanceHandler extends Handler {
    async get() {
        const access = await getAccessState(this.user._id);
        this.response.body = {
            allowed: access.allowed,
            isTeacher: access.isTeacher,
            unlimited: access.unlimited,
            balance: access.balance,
            balanceText: access.unlimited || access.isTeacher ? '不限' : formatMoney(access.balance),
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

class Ai33AnalyzeStreamHandler extends ConnectionHandler {
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
        const config = await resolveChatConfig(access.isTeacher ? cfg.teacher_model : cfg.student_model);
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

        const { resultsText, systemPrompt, userPrompt } = buildPrompts(rdoc, brief, access.isTeacher, rdoc.lang || '未知');

        const acquired = await acquireAnalysisSlot(this);
        if (!acquired) return; // disconnected while queued

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        let fullText = '';
        let usage: any = null;

        this.send({ status: 'analyzing' });
        const tFetch = Date.now();

        try {
            const resp = await fetch(`${config.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: true,
                    // DeepSeek only reports token usage on streams when asked.
                    stream_options: { include_usage: true },
                    // Reasoning-style models burn completion tokens on
                    // thinking; keep the cap well above the ~500-char answer.
                    max_tokens: 8192,
                    temperature: 0.7,
                }),
                signal: controller.signal,
            });

            if (!resp.ok) {
                const errText = await resp.text();
                this.send({ error: `AI API error (${resp.status}): ${errText}` });
                this.close(4000, 'API error');
                return;
            }

            const reader = (resp.body as any).getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let firstChunkAt = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.usage) usage = parsed.usage;
                        const delta = parsed.choices?.[0]?.delta;
                        // Reasoning-style models stream reasoning_content long
                        // before content; forward it so the user sees progress
                        // immediately instead of staring at a spinner.
                        const reasoning = delta?.reasoning_content;
                        const content = delta?.content;
                        if ((reasoning || content) && !firstChunkAt) {
                            firstChunkAt = Date.now();
                            console.info(`[ai33] analyze ${rid}: model=${config.model} provider=${config.provider || 'env'}, prep=${tFetch - t0}ms, ttft=${firstChunkAt - tFetch}ms`);
                        }
                        if (reasoning) this.send({ rchunk: reasoning });
                        if (content) {
                            fullText += content;
                            this.send({ chunk: content });
                        }
                    } catch {}
                }
            }

            clearTimeout(timer);

            if (!fullText) {
                this.send({ error: 'No response from AI.' });
                this.close(4000, 'Empty response');
                return;
            }

            const cost = calcCost(usage, config.price);
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
            clearTimeout(timer);
            const errorMsg = e.name === 'AbortError' ? 'Request timed out' : e.message;
            this.send({ error: `Request failed: ${errorMsg}` });
        } finally {
            releaseAnalysisSlot();
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_ai_admin', '/oi33/ai/admin', Ai33AdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_access', '/oi33/ai/access', Ai33AccessHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_models', '/oi33/ai/models', Ai33ModelsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_summary', '/oi33/ai/summary', Ai33SummaryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_analyze_page', '/oi33/ai/analyze/:rid', Ai33AnalyzePageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('oi33_ai_analyze_stream', '/oi33/ai/analyze-stream/:rid', Ai33AnalyzeStreamHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_can_analyze', '/oi33/ai/can-analyze', Ai33CanAnalyzeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_analysis_get', '/oi33/ai/analysis/:rid', Ai33AnalysisGetHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_analysis_delete', '/oi33/ai/analysis/:rid/delete', Ai33AnalysisDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_ai_balance', '/oi33/ai/balance', Ai33BalanceHandler, PRIV.PRIV_USER_PROFILE);
}
