import {
    Handler, NotFoundError, Types, UserModel, param, query,
} from 'hydrooj';
import { oi33Model } from '../../model';
import { AI_DEFAULT_BASE_URL } from '../../model/ai';
import { checkOi33Admin } from '../utils';
import {
    DEFAULT_STUDENT_SYSTEM_PROMPT, DEFAULT_TEACHER_SYSTEM_PROMPT, DIFFICULTY_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT,
    formatMoney, getAccessState, validEffort,
} from './prompts';

// --- Admin hub ---

export class Ai33AdminHandler extends Handler {
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

export class Ai33AccessHandler extends Handler {
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

export class Ai33ModelsHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const [providers, config] = await Promise.all([
            oi33Model.aiGetProviders(),
            oi33Model.aiGetConfig(),
        ]);
        this.response.template = 'oi33_ai_models.html';
        this.response.body = {
            providers,
            config,
            defaultPrompts: {
                student: DEFAULT_STUDENT_SYSTEM_PROMPT,
                teacher: DEFAULT_TEACHER_SYSTEM_PROMPT,
                summary: SUMMARY_SYSTEM_PROMPT,
                difficulty: DIFFICULTY_SYSTEM_PROMPT,
            },
        };
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
    @param('student_prompt', Types.String, true)
    @param('teacher_prompt', Types.String, true)
    @param('summary_prompt', Types.String, true)
    @param('difficulty_prompt', Types.String, true)
    @param('student_effort', Types.String, true)
    @param('teacher_effort', Types.String, true)
    @param('summary_effort', Types.String, true)
    async post(
        _domainId: string, action: string,
        provider?: string, base_url?: string, api_key?: string,
        model?: string, input = 0, input_cached = 0, output = 0,
        student_model?: string, teacher_model?: string, summary_model?: string,
        student_prompt?: string, teacher_prompt?: string, summary_prompt?: string,
        difficulty_prompt?: string,
        student_effort?: string, teacher_effort?: string, summary_effort?: string,
    ) {
        await checkOi33Admin(this.user._id);
        if (action === 'save_provider' && provider) {
            const existing = (await oi33Model.aiGetProviders()).find((p) => p._id === provider);
            if (!existing && !api_key) throw new Error('添加新 Provider 时必须填写 API Key。');
            if (existing && !existing.apiKey && !api_key) throw new Error('该 Provider 尚未配置 API Key，请填写。');
            await oi33Model.aiSaveProvider(provider, base_url || AI_DEFAULT_BASE_URL, api_key || '');
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
                // Empty prompt = fall back to the built-in default.
                student_prompt: (student_prompt || '').trim(),
                teacher_prompt: (teacher_prompt || '').trim(),
                summary_prompt: (summary_prompt || '').trim(),
                difficulty_prompt: (difficulty_prompt || '').trim(),
                student_effort: validEffort(student_effort),
                teacher_effort: validEffort(teacher_effort),
                summary_effort: validEffort(summary_effort),
            });
        }
        this.response.redirect = this.url('oi33_ai_models');
    }
}

// --- Balance (visible to the user themselves) ---

export class Ai33BalanceHandler extends Handler {
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
