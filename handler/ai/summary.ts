import {
    ConnectionHandler, DocumentModel, Handler, NotFoundError, Types, ValidationError, param, query,
} from 'hydrooj';
import { oi33Model } from '../../model';
import { aiChat, aiChatStream, aiResolveChatConfig } from '../../model/ai';
import { checkOi33Admin, checkUserFlag } from '../utils';
import {
    DIFFICULTY_MARKER, DIFFICULTY_SYSTEM_PROMPT, SUMMARY_DIFFICULTY_TAIL, SUMMARY_SYSTEM_PROMPT, optimizeProblemContent,
} from './prompts';

// Generate (or regenerate) the condensed statement for a problem and record the
// cost globally (never charged to a user). Returns the summary text or ''.
// When onChunk/onRChunk are given, streams the generation live to the caller.
export async function generateProblemSummary(
    domainId: string, pid: number, fullText: string, modelName: string,
    onChunk?: (text: string) => void, onRChunk?: (text: string) => void,
): Promise<string> {
    const config = await aiResolveChatConfig(modelName);
    if (!config.apiKey) return '';
    const cfg = await oi33Model.aiGetConfig();
    const systemPrompt = cfg.summary_prompt || SUMMARY_SYSTEM_PROMPT;
    // Generous budget: reasoning-style models burn completion tokens on
    // thinking, and LaTeX-heavy summaries are token-dense.
    const { content, finishReason } = onChunk
        ? await aiChatStream({
            config, system: systemPrompt, user: fullText, maxTokens: 8192,
            effort: cfg.summary_effort, usage: { uid: 0, type: 'summary', domainId, pid }, onChunk, onRChunk,
        })
        : await aiChat({
            config, system: systemPrompt, user: fullText, maxTokens: 8192,
            effort: cfg.summary_effort, usage: { uid: 0, type: 'summary', domainId, pid },
        });
    if (!content) return '';
    // Never cache a truncated summary.
    if (finishReason === 'length') return '';
    await oi33Model.aiSaveProblemSummary(domainId, pid, content, config.model);
    return content;
}

// Judge the Luogu-scale difficulty (1-8) from the condensed statement and
// cache it on the summary doc. Cost is recorded globally (type 'summary'),
// never charged to a user. On failure returns difficulty: null plus the
// underlying reason so callers can show it instead of a generic message.
async function generateProblemDifficulty(
    domainId: string, pid: number, briefText: string, modelName: string,
): Promise<{ difficulty: number | null; error: string }> {
    const fail = (error: string) => ({ difficulty: null, error });
    const config = await aiResolveChatConfig(modelName);
    if (!config.apiKey) return fail('未配置 API Key。');
    const cfg = await oi33Model.aiGetConfig();
    const systemPrompt = cfg.difficulty_prompt || DIFFICULTY_SYSTEM_PROMPT;
    // No response_format json mode here: thinking-mode models reject it with
    // a 400, and reasoning can exhaust a tiny max_tokens before any JSON
    // lands. The prompt already demands a bare JSON object; extract it.
    const { content, error } = await aiChat({
        config, system: systemPrompt, user: briefText, maxTokens: 8192,
        effort: cfg.summary_effort, timeoutMs: 300000,
        usage: { uid: 0, type: 'summary', domainId, pid },
    });
    if (!content) return fail(error || 'API 无响应。');
    // Models may wrap the JSON in prose or code fences; extract it leniently.
    let parsed: any = null;
    const match = content.match(/\{[^{}]*"difficulty"\s*:\s*\d+[^{}]*\}/);
    try { parsed = match ? JSON.parse(match[0]) : null; } catch { /* fall through */ }
    const difficulty = Number(parsed?.difficulty);
    if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > 8) return fail('模型未返回有效难度。');
    await oi33Model.aiSaveProblemDifficulty(domainId, pid, difficulty, config.model);
    return { difficulty, error: '' };
}

// Combined generation: one call produces the condensed statement AND the
// difficulty (trailing [[难度]]N marker). Saves the summary and, when parsed,
// the difficulty to the cache; cost is recorded once globally (type
// 'summary'), never charged to a user. Streams when onChunk is given.
async function generateProblemSummaryWithDifficulty(
    domainId: string, pid: number, fullText: string, modelName: string,
    onChunk?: (text: string) => void, onRChunk?: (text: string) => void,
    // Manual regeneration raises the limits: hard problems think for minutes.
    limits: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<{ summary: string; difficulty: number | null }> {
    const config = await aiResolveChatConfig(modelName);
    if (!config.apiKey) return { summary: '', difficulty: null };
    const cfg = await oi33Model.aiGetConfig();
    const systemPrompt = `${cfg.summary_prompt || SUMMARY_SYSTEM_PROMPT}\n\n${SUMMARY_DIFFICULTY_TAIL}`;
    const { content, finishReason } = onChunk
        ? await aiChatStream({
            config, system: systemPrompt, user: fullText, maxTokens: limits.maxTokens || 8192,
            effort: cfg.summary_effort, timeoutMs: limits.timeoutMs,
            usage: { uid: 0, type: 'summary', domainId, pid }, onChunk, onRChunk,
        })
        : await aiChat({
            config, system: systemPrompt, user: fullText, maxTokens: limits.maxTokens || 8192,
            effort: cfg.summary_effort, timeoutMs: limits.timeoutMs,
            usage: { uid: 0, type: 'summary', domainId, pid },
        });
    // Never cache a truncated summary.
    if (!content || finishReason === 'length') return { summary: '', difficulty: null };
    let summary = content;
    let difficulty: number | null = null;
    const markerIdx = content.lastIndexOf(DIFFICULTY_MARKER);
    if (markerIdx >= 0) {
        const parsed = Number(content.slice(markerIdx + DIFFICULTY_MARKER.length).trim());
        if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 8) difficulty = parsed;
        summary = content.slice(0, markerIdx).trim();
    }
    if (!summary) return { summary: '', difficulty: null };
    await oi33Model.aiSaveProblemSummary(domainId, pid, summary, config.model);
    if (difficulty) await oi33Model.aiSaveProblemDifficulty(domainId, pid, difficulty, config.model);
    return { summary, difficulty };
}

// Set the problem's difficulty only when it has no rating yet; rated problems
// keep their rating and just show the AI badge on the summary page.
async function applyAiDifficultyIfUnset(
    domainId: string, pdoc: any, difficulty: number | null,
): Promise<boolean> {
    if (!pdoc || !difficulty) return false;
    if (Number(pdoc.difficulty) >= 1) return false;
    await global.Hydro.model.problem.edit(domainId, pdoc.docId, { difficulty });
    return true;
}

// --- Problem summary (精简题意) view / edit / regenerate ---

export class Ai33SummaryHandler extends Handler {
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
        const cfg = await oi33Model.aiGetConfig();
        this.response.template = 'oi33_ai_summary.html';
        this.response.body = {
            domainId, pid: pid ?? '', pdoc, summary, summaryModel: cfg.summary_model,
        };
    }

    @param('action', Types.String)
    @param('domainId', Types.String, true)
    @param('pid', Types.ProblemId)
    async post(_d: string, action: string, domainId = 'system', pid: number | string) {
        await checkOi33Admin(this.user._id);
        const cfg = await oi33Model.aiGetConfig();
        if (action === 'regenerate') {
            const pdoc = await global.Hydro.model.problem.get(domainId, pid).catch(() => null);
            if (!pdoc) throw new NotFoundError(pid);
            const fullText = [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n');
            // One call produces both the summary and the difficulty.
            const { summary, difficulty } = await generateProblemSummaryWithDifficulty(
                domainId, pdoc.docId, fullText, cfg.summary_model,
                undefined, undefined, { maxTokens: 16384, timeoutMs: 300000 },
            );
            if (!summary) throw new Error('生成失败：请检查模型配置与 API Key，或稍后再试。');
            await applyAiDifficultyIfUnset(domainId, pdoc, difficulty);
        } else if (action === 'difficulty') {
            const pdoc = await global.Hydro.model.problem.get(domainId, pid).catch(() => null);
            if (!pdoc) throw new NotFoundError(pid);
            const summary = await oi33Model.aiGetProblemSummary(domainId, pdoc.docId);
            if (!summary?.content) throw new ValidationError('请先生成精简题意。');
            const { difficulty, error } = await generateProblemDifficulty(domainId, pdoc.docId, summary.content, cfg.summary_model);
            if (!difficulty) throw new Error(`难度评判失败：${error || '请稍后再试。'}`);
            await applyAiDifficultyIfUnset(domainId, pdoc, difficulty);
        }
        this.response.redirect = this.url('oi33_ai_summary', { query: { domainId, pid } });
    }
}

// --- Batch summary + difficulty generation over a sort range ---

const SUMMARY_BATCH_MAX = 500;
let summaryBatchRunning = false;

// Sort keys come in shapes like "1000" or "ABC123A": normalize to
// [prefix, number, tail] so ranges compare prefix-first, then numerically.
type SortKey = [string, number, string];

function parseSortKey(text: any): SortKey | null {
    const m = /^([A-Za-z]*)(\d+)([A-Za-z]*)$/.exec(String(text ?? '').trim());
    if (!m) return null;
    return [m[1].toUpperCase(), Number(m[2]), m[3].toUpperCase()];
}

function compareSortKeys(a: SortKey, b: SortKey): number {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] - b[1];
    if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
    return 0;
}

async function runSummaryBatch(domainId: string, problems: any[]) {
    const counters = {
        done: 0, generated: 0, difficulties: 0, applied: 0, skipped: 0, failed: 0,
    };
    try {
        const cfg = await oi33Model.aiGetConfig();
        for (const pdoc of problems) {
            const sortText = String(pdoc.sort ?? pdoc.docId);
            try {
                let acted = false;
                const cached = await oi33Model.aiGetProblemSummary(domainId, pdoc.docId);
                let brief = cached?.content || '';
                // Fresh generation returns the difficulty in the same call.
                let freshDifficulty: number | null = null;
                if (!brief) {
                    const fullText = [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n');
                    const result = await generateProblemSummaryWithDifficulty(domainId, pdoc.docId, fullText, cfg.summary_model);
                    brief = result.summary;
                    freshDifficulty = result.difficulty;
                    if (brief) {
                        counters.generated++;
                        acted = true;
                    }
                }
                if (!brief) {
                    counters.failed++;
                } else {
                    const known = cached?.difficulty || 0;
                    let difficulty = known >= 1 && known <= 8 ? known : null;
                    if (!difficulty && freshDifficulty) {
                        difficulty = freshDifficulty;
                        counters.difficulties++;
                    }
                    if (!difficulty) {
                        // Cached summary without a difficulty: judge it on its own.
                        difficulty = (await generateProblemDifficulty(domainId, pdoc.docId, brief, cfg.summary_model)).difficulty;
                        if (difficulty) {
                            counters.difficulties++;
                            acted = true;
                        }
                    }
                    if (!difficulty) {
                        counters.failed++;
                    } else {
                        if (await applyAiDifficultyIfUnset(domainId, pdoc, difficulty)) {
                            counters.applied++;
                            acted = true;
                        }
                        if (!acted) counters.skipped++;
                    }
                }
            } catch (e: any) {
                counters.failed++;
                console.error(`[oi33] summary batch: problem ${sortText} failed:`, e);
            }
            counters.done++;
            await oi33Model.aiBatchSaveStatus({ ...counters, currentSort: sortText });
            // Stay sequential and yield so a large batch cannot monopolize
            // the Hydro process (same discipline as the medal scan).
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await oi33Model.aiBatchSaveStatus({ finishedAt: new Date() });
    } catch (e: any) {
        console.error('[oi33] summary batch failed:', e);
        await oi33Model.aiBatchSaveStatus({ lastError: e?.message || String(e), finishedAt: new Date() });
    } finally {
        await oi33Model.aiBatchSaveStatus({ running: false }).catch(() => {});
        summaryBatchRunning = false;
    }
}

export class Ai33SummaryBatchHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const status = await oi33Model.aiBatchGetStatus();
        this.response.template = 'oi33_ai_batch.html';
        this.response.body = { status, maxRange: SUMMARY_BATCH_MAX };
    }

    @param('start', Types.String)
    @param('end', Types.String)
    @param('domainId', Types.String, true)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async post(_d: any, start: string, end: string, domainId = 'system') {
        await checkOi33Admin(this.user._id);
        if (summaryBatchRunning) throw new ValidationError('批量生成正在进行中。');
        const startKey = parseSortKey(start);
        const endKey = parseSortKey(end);
        if (!startKey || !endKey || compareSortKeys(startKey, endKey) > 0) {
            throw new ValidationError('题号区间无效，支持纯数字（如 1000）或字母数字混合（如 ABC123A）。');
        }
        const problems = (await DocumentModel.coll.find({
            domainId,
            docType: DocumentModel.TYPE_PROBLEM,
        }, {
            projection: {
                docId: 1, sort: 1, difficulty: 1, title: 1, content: 1,
            },
        }).toArray())
            .map((pdoc: any) => ({ pdoc, key: parseSortKey(pdoc.sort ?? pdoc.docId) }))
            .filter((x: any) => x.key && compareSortKeys(x.key, startKey) >= 0 && compareSortKeys(x.key, endKey) <= 0)
            .sort((a: any, b: any) => compareSortKeys(a.key, b.key))
            .map((x: any) => x.pdoc);
        if (!problems.length) throw new ValidationError('区间内没有题目。');
        if (problems.length > SUMMARY_BATCH_MAX) {
            throw new ValidationError(`单次最多处理 ${SUMMARY_BATCH_MAX} 道题（当前区间 ${problems.length} 道）。`);
        }
        summaryBatchRunning = true;
        await oi33Model.aiBatchSaveStatus({
            running: true,
            domainId,
            start: start.trim(),
            end: end.trim(),
            total: problems.length,
            done: 0,
            generated: 0,
            difficulties: 0,
            applied: 0,
            skipped: 0,
            failed: 0,
            currentSort: '',
            startedAt: new Date(),
            finishedAt: null as any,
            lastError: '',
        });
        runSummaryBatch(domainId, problems);
        this.response.redirect = this.url('oi33_ai_summary_batch');
    }
}

// --- Problem summary stream handler (WebSocket) ---

// One live summary/difficulty stream per problem: a second connection would
// double-spend on the same generation.
const summaryStreamInFlight = new Set<string>();

export class Ai33SummaryStreamHandler extends ConnectionHandler {
    @query('domainId', Types.String, true)
    @query('pid', Types.ProblemId)
    @query('action', Types.String)
    async prepare(_d: string, domainId = 'system', pid: number | string, action: string) {
        if ((await checkUserFlag(this.user._id)) < 2) {
            this.send({ error: 'Permission denied.' });
            this.close(4000, 'Forbidden');
            return;
        }
        const pdoc = await global.Hydro.model.problem.get(domainId, pid).catch(() => null);
        if (!pdoc) {
            this.send({ error: 'Problem not found' });
            this.close(4000, 'Not found');
            return;
        }
        if (action !== 'regenerate' && action !== 'difficulty') {
            this.send({ error: 'Unknown action.' });
            this.close(4000, 'Bad action');
            return;
        }
        const key = `${domainId}:${pdoc.docId}`;
        if (summaryStreamInFlight.has(key)) {
            this.send({ error: '该题正在生成中，请稍候。' });
            this.close(4000, 'In flight');
            return;
        }
        summaryStreamInFlight.add(key);
        const cfg = await oi33Model.aiGetConfig();
        try {
            if (action === 'regenerate') {
                const fullText = [`# ${pdoc.title || ''}`, '', optimizeProblemContent(pdoc.content || '')].join('\n');
                this.send({ status: 'generating' });
                // One call streams the summary and ends with the difficulty marker.
                const { summary, difficulty } = await generateProblemSummaryWithDifficulty(
                    domainId, pdoc.docId, fullText, cfg.summary_model,
                    (c) => this.send({ chunk: c }), (r) => this.send({ rchunk: r }),
                    { maxTokens: 16384, timeoutMs: 300000 },
                );
                if (!summary) {
                    this.send({ error: '生成失败：请检查模型配置与 API Key，或稍后再试。' });
                    return;
                }
                await applyAiDifficultyIfUnset(domainId, pdoc, difficulty);
                this.send({ done: true, fullText: summary, difficulty });
            } else {
                const summary = await oi33Model.aiGetProblemSummary(domainId, pdoc.docId);
                if (!summary?.content) {
                    this.send({ error: '请先生成精简题意。' });
                    return;
                }
                this.send({ status: 'difficulty' });
                const { difficulty, error } = await generateProblemDifficulty(domainId, pdoc.docId, summary.content, cfg.summary_model);
                if (!difficulty) {
                    this.send({ error: `难度评判失败：${error || '请稍后再试。'}` });
                    return;
                }
                await applyAiDifficultyIfUnset(domainId, pdoc, difficulty);
                this.send({ done: true });
            }
        } finally {
            summaryStreamInFlight.delete(key);
        }
    }
}
