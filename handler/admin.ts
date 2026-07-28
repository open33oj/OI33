import { Handler, PRIV, Types, query, Context, UserModel, ObjectId } from 'hydrooj';
import Schema from 'schemastery';
import { oi33Model } from '../model';
import { migrate, previewMigration } from '../migrate';
import { runExport } from '../scripts/export-hydro-data';
import { runUpdateRatings } from '../scripts/update-ratings';
import { checkOi33Admin } from './utils';

// --- Admin dashboard ---

class Oi33AdminHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('type', Types.String, true)
    async get(domainId: string, page = 1, type = '') {
        await checkOi33Admin(this.user._id);
        await oi33Model.compactRequestLogs();
        const { activities, tpcount } = await oi33Model.getRecentActivitiesPaginated(page, 30, type);
        const pendingCount = await oi33Model.getPendingRequestCount();
        const uidSet = new Set<number>();
        const reqIdSet = new Set<string>();
        for (const a of activities) {
            (a as any).timestamp = (a as any).createdAt instanceof Date
                ? (a as any).createdAt
                : a._id instanceof Date ? a._id : new ObjectId(a._id as any).getTimestamp();
            for (const k of ['sender', 'receiver', 'userId', 'owner', 'requester', 'uid'] as const) {
                const v = a[k];
                if (typeof v === 'number') uidSet.add(v);
            }
            if (a.type === 'request' && a.reqId) reqIdSet.add(a.reqId);
        }
        const [udict, reqDict] = await Promise.all([
            uidSet.size ? UserModel.getList(domainId, Array.from(uidSet)) : {},
            oi33Model.getRequestsByIds(Array.from(reqIdSet)),
        ]);
        this.response.template = 'oi33_admin.html';
        this.response.body = {
            activities, pendingCount, page, tpcount, udict, reqDict, logType: type,
        };
    }
}

// --- Migration handler ---

class MigrateHandler extends Handler {
    async get() {
        await checkOi33Admin(this.user._id);
        const preview = await previewMigration();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { preview };
    }

    async post() {
        await checkOi33Admin(this.user._id);
        const result = await migrate();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { result, done: true };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_admin', '/oi33/admin', Oi33AdminHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_migrate', '/oi33/migrate', MigrateHandler, PRIV.PRIV_USER_PROFILE);

    ctx.addScript(
        'exportHydroData',
        'Export problems, contests, records and user snapshots within date range for AI analysis',
        Schema.object({
            startDate: Schema.string(),
            endDate: Schema.string(),
            outputDir: Schema.string(),
            includeCode: Schema.boolean(),
            domainId: Schema.array(Schema.string()),
        }),
        runExport,
    );

    ctx.addScript(
        'updateRatings',
        'Update AtCoder / Codeforces ratings for all users with approved accounts',
        Schema.object({}),
        runUpdateRatings,
    );
}
