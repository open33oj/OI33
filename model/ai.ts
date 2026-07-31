import { db, ObjectId } from 'hydrooj';
import crypto from 'crypto';
import type {
    Oi33AiAccess, Oi33AiAnalysis, Oi33AiConfig, Oi33AiProblemSummary,
    Oi33AiProvider, Oi33AiProviderModel, Oi33AiUsage,
} from './types';

export const aiAnalysisColl = db.collection<Oi33AiAnalysis>('oi33_ai_analysis');
export const aiConfigColl = db.collection<Oi33AiConfig>('oi33_ai_config');
export const aiProblemSummaryColl = db.collection<Oi33AiProblemSummary>('oi33_ai_problem_summary');
export const aiProviderColl = db.collection<Oi33AiProvider>('oi33_ai_provider');
export const aiAccessColl = db.collection<Oi33AiAccess>('oi33_ai_access');
export const aiUsageColl = db.collection<Oi33AiUsage>('oi33_ai_usage');

const LEGACY_AI33_COLLECTIONS = [
    'ai33_analysis', 'ai33_config', 'ai33_problem_summary',
    'ai33_provider', 'ai33_access', 'ai33_usage',
];

// One-off upgrade: drop the legacy ai33_ collections (data is not carried over).
export async function dropLegacyAi33Collections() {
    for (const name of LEGACY_AI33_COLLECTIONS) {
        try {
            await db.collection(name).drop();
            console.info(`[oi33] dropped legacy collection ${name}`);
        } catch (e: any) {
            // NamespaceNotFound = already gone; anything else is worth logging.
            if (e?.code !== 26 && e?.codeName !== 'NamespaceNotFound') {
                console.error(`[oi33] failed to drop legacy collection ${name}:`, e);
            }
        }
    }
}

// --- Record lookup (read-only, straight from Hydro's record collection) ---

function ridToQuery(rid: string): ObjectId | null {
    try {
        return new ObjectId(rid);
    } catch {
        return null;
    }
}

async function findRecordByRid(rid: string, projection?: object): Promise<any | null> {
    const oid = ridToQuery(rid);
    if (oid) {
        try {
            return await db.collection('record').findOne({ _id: oid }, { projection });
        } catch (e: any) {
            if (e?.code !== 'BSONVersionError' && e?.message?.includes('BSON') === false) throw e;
        }
    }
    // Fallback: compare _id as string (avoids ObjectId BSON version issues)
    try {
        return await db.collection('record').findOne(
            { $expr: { $eq: [{ $toString: '$_id' }, rid] } },
            { projection },
        );
    } catch {
        return null;
    }
}

export async function aiGetRecordDetail(rid: string): Promise<{
    code: string; lang: string; pid: number; domainId: string;
    uid: number; status: number; score: number; time: number;
    memory: number; testCases: any[]; contest: any;
} | null> {
    const rdoc = await findRecordByRid(rid);
    if (!rdoc) return null;
    return {
        code: rdoc.code || '',
        lang: rdoc.lang || '',
        pid: rdoc.pid,
        domainId: rdoc.domainId,
        uid: rdoc.uid,
        status: rdoc.status,
        score: rdoc.score || 0,
        time: rdoc.time || 0,
        memory: rdoc.memory || 0,
        testCases: rdoc.testCases || [],
        contest: rdoc.contest || null,
    };
}

export async function aiIsContestRecord(rid: string): Promise<boolean> {
    const rdoc = await findRecordByRid(rid, { projection: { contest: 1 } });
    if (!rdoc?.contest) return false;
    const hex = typeof rdoc.contest.toHexString === 'function' ? rdoc.contest.toHexString() : String(rdoc.contest);
    return !hex.startsWith('00000000000000000000000');
}

// --- Problem summary cache (精简题意, shared per-problem) ---

export async function aiGetProblemSummary(domainId: string, pid: number) {
    return await aiProblemSummaryColl.findOne({ _id: `${domainId}:${pid}` });
}

export async function aiSaveProblemSummary(domainId: string, pid: number, content: string, model: string) {
    await aiProblemSummaryColl.updateOne(
        { _id: `${domainId}:${pid}` },
        {
            $set: {
                domainId, pid, content, model, createdAt: new Date(),
            },
        },
        { upsert: true },
    );
}

// --- Analysis persistence (shared per-record) ---

export async function aiGetAnalysis(rid: string) {
    return await aiAnalysisColl.findOne({ rid });
}

export async function aiSaveAnalysis(data: Omit<Oi33AiAnalysis, '_id' | 'createdAt'>) {
    const _id = crypto.randomBytes(16).toString('hex');
    await aiAnalysisColl.updateOne(
        { rid: data.rid },
        {
            $set: { ...data, createdAt: new Date() },
            $setOnInsert: { _id },
        },
        { upsert: true },
    );
}

export async function aiDeleteAnalysis(rid: string) {
    await aiAnalysisColl.deleteOne({ rid });
}

// --- Access allow-list & balances (按钱计费) ---

export async function aiGetAccess(uid: number) {
    return await aiAccessColl.findOne({ _id: uid });
}

export async function aiGetAccessList() {
    return await aiAccessColl.find().sort({ _id: 1 }).toArray();
}

export async function aiSetAccess(uid: number, granted: number, unlimited: boolean) {
    const used = (await aiGetUsedMap([uid]))[uid] || 0;
    const balance = Math.max(0, granted - used);
    await aiAccessColl.updateOne(
        { _id: uid },
        {
            $set: { granted, balance, unlimited },
            $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
    );
}

export async function aiRemoveAccess(uid: number) {
    await aiAccessColl.deleteOne({ _id: uid });
}

// Incremental top-up: raises both granted and balance by `amount`.
export async function aiAddQuota(uid: number, amount: number) {
    const doc = await aiAccessColl.findOne({ _id: uid });
    if (!doc) return false;
    if (doc.granted === undefined) {
        // Legacy doc: initialize granted from balance + already-used quota.
        const used = (await aiGetUsedMap([uid]))[uid] || 0;
        await aiAccessColl.updateOne(
            { _id: uid },
            { $set: { granted: Math.max(0, (doc.balance || 0) + used) } },
        );
    }
    await aiAccessColl.updateOne(
        { _id: uid },
        { $inc: { granted: amount, balance: amount } },
    );
    return true;
}

export async function aiDeductBalance(uid: number, cost: number) {
    await aiAccessColl.updateOne(
        { _id: uid, unlimited: { $ne: true } },
        { $inc: { balance: -cost } },
    );
}

// --- Providers & model pricing ---

export async function aiGetProviders() {
    return await aiProviderColl.find().sort({ _id: 1 }).toArray();
}

export async function aiSaveProvider(name: string, baseUrl: string, apiKey: string) {
    const $set: Record<string, string> = { baseUrl };
    // Empty apiKey keeps the stored one (masked in the form).
    if (apiKey) $set.apiKey = apiKey;
    await aiProviderColl.updateOne(
        { _id: name },
        { $set, $setOnInsert: { models: [] } },
        { upsert: true },
    );
}

export async function aiDeleteProvider(name: string) {
    await aiProviderColl.deleteOne({ _id: name });
}

export async function aiUpsertProviderModel(provider: string, model: Oi33AiProviderModel) {
    await aiProviderColl.updateOne({ _id: provider }, { $pull: { models: { name: model.name } } });
    await aiProviderColl.updateOne({ _id: provider }, { $push: { models: model } });
}

export async function aiDeleteProviderModel(provider: string, modelName: string) {
    await aiProviderColl.updateOne({ _id: provider }, { $pull: { models: { name: modelName } } });
}

export async function aiResolveModel(modelName: string): Promise<{
    provider: string; baseUrl: string; apiKey: string; price: Oi33AiProviderModel | null;
} | null> {
    const providers = await aiGetProviders();
    for (const p of providers) {
        const m = (p.models || []).find((x) => x.name === modelName);
        if (m) {
            return {
                provider: p._id, baseUrl: p.baseUrl, apiKey: p.apiKey, price: m,
            };
        }
    }
    // Single-provider setups: use it for any model name, even ones without a
    // price entry (cost is then recorded as 0).
    if (providers.length === 1 && providers[0].apiKey) {
        const p = providers[0];
        return {
            provider: p._id, baseUrl: p.baseUrl, apiKey: p.apiKey, price: null,
        };
    }
    return null;
}

// --- Usage & billing ---

export async function aiAddUsage(entry: Omit<Oi33AiUsage, '_id' | 'createdAt'>) {
    await aiUsageColl.insertOne({ ...entry, _id: new ObjectId(), createdAt: new Date() });
}

// Total charged cost per user (已从余额扣掉的部分).
export async function aiGetUsedMap(uids: number[]): Promise<Record<number, number>> {
    if (!uids.length) return {};
    const rows = await aiUsageColl.aggregate<{ _id: number; cost: number }>([
        { $match: { uid: { $in: uids }, type: 'analysis', deducted: true } },
        { $group: { _id: '$uid', cost: { $sum: '$cost' } } },
    ]).toArray();
    const map: Record<number, number> = {};
    for (const r of rows) map[r._id] = r.cost;
    return map;
}

export async function aiGetUsageStats() {
    const rows = await aiUsageColl.aggregate<{
        _id: { type: string; deducted: boolean };
        cost: number; count: number; promptTokens: number; completionTokens: number;
    }>([
        {
            $group: {
                _id: { type: '$type', deducted: '$deducted' },
                cost: { $sum: '$cost' },
                count: { $sum: 1 },
                promptTokens: { $sum: '$promptTokens' },
                completionTokens: { $sum: '$completionTokens' },
            },
        },
    ]).toArray();
    const empty = () => ({
        cost: 0, count: 0, promptTokens: 0, completionTokens: 0,
    });
    const stats = {
        summary: empty(), analysisCharged: empty(), analysisFree: empty(),
    };
    for (const row of rows) {
        const target = row._id.type === 'summary'
            ? stats.summary
            : (row._id.deducted ? stats.analysisCharged : stats.analysisFree);
        target.cost += row.cost;
        target.count += row.count;
        target.promptTokens += row.promptTokens;
        target.completionTokens += row.completionTokens;
    }
    return stats;
}

// --- Config (which model each role uses) ---

const defaultAiConfig: Omit<Oi33AiConfig, '_id'> = {
    student_model: 'deepseek-v4-flash',
    teacher_model: 'deepseek-v4-pro',
    summary_model: 'deepseek-v4-flash',
};

export async function aiGetConfig(): Promise<Oi33AiConfig> {
    const doc = await aiConfigColl.findOne({ _id: 'main' });
    return { _id: 'main', ...defaultAiConfig, ...(doc || {}) };
}

export async function aiSaveConfig(data: Partial<Omit<Oi33AiConfig, '_id'>>) {
    await aiConfigColl.updateOne(
        { _id: 'main' },
        { $set: data },
        { upsert: true },
    );
}
