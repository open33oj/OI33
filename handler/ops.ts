import {
    Context, ForbiddenError, Handler, PRIV, ValidationError, db,
} from 'hydrooj';
import { oi33Model } from '../model';
import { addLog } from '../model/log';
import { getOpsStatus, recordOpsAction } from '../model/ops-status';
import { checkOi33Admin } from './utils';

// 运维与健康页：一个进程级快照 + 一组可重复执行的安全修复动作。
// 这里刻意不写新的业务逻辑——每个动作都调用 model 里已有的公开 API，
// 这样“后台按钮”和“启动/定时任务”走的是同一条代码路径。

interface OpsAction {
    label: string;
    description: string;
    minFlag?: number;
    run: (operator: number) => Promise<string>;
}

const ACTIONS: Record<string, OpsAction> = {
    recount_territories: {
        label: '重算大猫领地',
        description: '按地图格子的归属重算每只大猫的 territoryCount（幂等，可随时跑）。',
        run: async () => {
            const result: any = await oi33Model.recountSchoolCatTerritories();
            return `领地重算完成：${result?.catCount ?? '-'} 只大猫、${result?.cellCount ?? '-'} 格。`;
        },
    },
    calibrate_market: {
        label: '校准罐头市场',
        description: '按账本重算市场流通量、供应与储备（不改变用户余额）。',
        run: async (operator) => {
            const result: any = await oi33Model.calibrateCatCanPool(operator);
            const after = result?.after || {};
            return `市场已校准：流通 ${after.circulatingCans ?? '-'} 个，供应 ${after.virtualCanSupply ?? '-'} 个。`;
        },
    },
    rebuild_indexes: {
        label: '重建数据库索引',
        description: '补齐所有 oi33_* 集合的索引；幂等，适合升级后执行。',
        run: async () => {
            await Promise.all([
                oi33Model.ensureCatCanIndexes(),
                oi33Model.ensureCatAccountIndexes(),
                oi33Model.ensureSchoolCatIndexes(),
                oi33Model.ensureCatMapIndexes(),
                oi33Model.ensureMedalIndexes(),
                oi33Model.ensureBlindboxIndexes(),
                oi33Model.ensureAuctionIndexes(),
                oi33Model.ensureContractIndexes(),
                oi33Model.ensureModerationIndexes(),
                oi33Model.ensureMeowIndexes(),
                oi33Model.ensureAlgorithmIndexes(),
                oi33Model.ensureLogIndexes(),
            ]);
            return '索引已全部补齐。';
        },
    },
    evaluate_medals: {
        label: '重跑奖章评估',
        description: '按当前数据重新评估所有用户的 OJ 成就奖章；用户多时较慢，只升不降。',
        run: async () => {
            const result: any = await oi33Model.medalEvaluateAll();
            return `奖章扫描完成：${result?.users ?? '-'} 人，命中 ${result?.matched ?? '-'}，授予 ${result?.granted ?? '-'}。`;
        },
    },
    migrate_judge_monitor: {
        label: '导入旧版评测机配置',
        description: '把旧版写在系统设置里的 9 个 oi33.judge_monitor.* key 搬到 oi33_judge_monitor（幂等）。',
        run: async () => {
            const imported = await oi33Model.judgeMonitorMigrateFromSettings();
            return imported ? '已从系统设置导入评测机监控配置。' : '没有可导入的旧配置。';
        },
    },
    purge_unverified_cat_assets: {
        label: '清理未认证用户的猫资产',
        description: '清空未实名用户的地图位置、猫粮/罐头与贡献（行政管理员）。',
        minFlag: 3,
        run: async (operator) => {
            const result: any = await oi33Model.purgeUnverifiedCatAssets(operator);
            return `已清理 ${result?.users ?? '-'} 个未认证用户：猫粮 ${result?.food ?? 0}g、罐头 ${result?.cans ?? 0} 个。`;
        },
    },
    backfill_feed_refund_logs: {
        label: '补记大猫贡献退款流水',
        description: '为已执行退役退款、但只有汇总日志的历史投喂补写个人账户退款记录；'
            + '只补日志，不改余额，重复执行不会重复记账。',
        minFlag: 3,
        run: async () => {
            const result: any = await oi33Model.backfillFeedRefundLogs();
            return `新增 ${result?.inserted ?? 0} 条退款流水 / ${result?.insertedGrams ?? 0}g`
                + `（共处理 ${result?.users ?? 0} 位用户、${result?.grams ?? 0}g）；`
                + `已存在 ${result?.existing ?? 0} 条，跳过 ${result?.skipped ?? 0} 条。`;
        },
    },
};

const COLLECTION_COUNTS: Array<{ collection: string; label: string; cheap?: boolean }> = [
    { collection: 'oi33_user', label: '用户主档' },
    { collection: 'oi33_medal', label: '奖章定义' },
    { collection: 'oi33_user_medal', label: '奖章持有' },
    { collection: 'oi33_school_cat', label: '大猫' },
    { collection: 'oi33_cat_map_player', label: '地图小猫' },
    { collection: 'oi33_cat_map_cell', label: '地图格子', cheap: true },
    { collection: 'oi33_medal_blindbox', label: '盲盒组' },
    { collection: 'oi33_auction', label: '拍卖' },
    { collection: 'oi33_medal_contract', label: '合同' },
    { collection: 'oi33_meow_post', label: '喵喵' },
    { collection: 'oi33_ai_moderation', label: '审核记录', cheap: true },
    { collection: 'oi33_ai_usage', label: 'AI 用量', cheap: true },
    { collection: 'oi33_log', label: '审计日志', cheap: true },
    { collection: 'oi33_algorithm_item', label: '算法项目' },
];

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
});
const fmt = (value?: Date) => (value ? timeFmt.format(new Date(value)) : '—');
const errorMessage = (error: unknown) => String((error as any)?.message || error || '未知错误');

async function buildCounts() {
    const counts = await Promise.all(COLLECTION_COUNTS.map(async (item) => {
        const collection = db.collection(item.collection as any);
        const count = item.cheap
            ? await collection.estimatedDocumentCount()
            : await collection.countDocuments({});
        return { ...item, count };
    }));
    return counts;
}

async function buildPending() {
    const [requests, meow, moderation] = await Promise.all([
        db.collection('oi33_request').countDocuments({ status: 'pending' }),
        db.collection('oi33_meow_post').countDocuments({ status: 'pending' }),
        db.collection('oi33_ai_moderation').countDocuments({ status: 'pending' }),
    ]);
    return { requests, meow, moderation };
}

class OpsHandler extends Handler {
    async get() {
        const flag = await checkOi33Admin(this.user._id);
        const status = getOpsStatus();
        this.response.template = 'oi33_admin_ops.html';
        this.response.body = {
            flag,
            runtime: {
                instance: process.env.NODE_APP_INSTANCE || '0',
                node: process.version,
                uptime: Math.round(process.uptime()),
                memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                startedAt: fmt(status.startedAt),
            },
            applyFailures: status.applyFailures.map((item) => ({
                name: item.name, message: item.message, at: fmt(item.at),
            })),
            tasks: status.tasks.map((task) => ({
                name: task.name,
                lastRunAt: fmt(task.lastRunAt),
                lastSuccessAt: fmt(task.lastSuccessAt),
                lastError: task.lastError || '',
                lastMessage: task.lastMessage || '',
                runs: task.runs,
                failures: task.failures,
            })),
            actions: status.actions.map((item) => ({
                action: item.action,
                operator: item.operator,
                ok: item.ok,
                message: item.message,
                at: fmt(item.at),
            })),
            actionOptions: Object.entries(ACTIONS).map(([id, action]) => ({
                id,
                label: action.label,
                description: action.description,
                minFlag: action.minFlag || 2,
            })),
            counts: await buildCounts(),
            pending: await buildPending(),
        };
    }

    async post() {
        const flag = await checkOi33Admin(this.user._id);
        const action = String((this.request.body as any)?.action || '');
        const handler = ACTIONS[action];
        if (!handler) throw new ValidationError('未知的运维动作。');
        if (flag < (handler.minFlag || 2)) throw new ForbiddenError('权限不足，无法执行该运维动作。');

        let message = '';
        try {
            message = await handler.run(this.user._id);
        } catch (e) {
            const error = errorMessage(e);
            recordOpsAction(action, this.user._id, false, error);
            console.error(`[oi33] ops action "${action}" failed:`, e);
            this.response.redirect = this.url('oi33_admin_ops', {
                query: { notification: `操作失败：${error}` },
            });
            return;
        }
        recordOpsAction(action, this.user._id, true, message);
        await addLog({
            type: 'admin', userId: this.user._id, action: `ops_${action}`, reason: message,
        } as any);
        this.response.redirect = this.url('oi33_admin_ops', {
            query: { notification: message },
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_admin_ops', '/oi33/admin/ops', OpsHandler, PRIV.PRIV_USER_PROFILE);
}
