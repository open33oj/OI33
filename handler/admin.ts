import { Handler, PRIV, Context } from 'hydrooj';
import Schema from 'schemastery';
import { oi33Model } from '../model';
import { migrate, previewMigration } from '../migrate';
import { runExport } from '../scripts/export-hydro-data';

// --- Admin dashboard ---

class Oi33AdminHandler extends Handler {
    async get() {
        const activities = await oi33Model.getRecentActivities(40);
        this.response.template = 'oi33_admin.html';
        this.response.body = { activities };
    }
}

// --- Migration handler ---

class MigrateHandler extends Handler {
    async get() {
        const preview = await previewMigration();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { preview };
    }

    async post() {
        const result = await migrate();
        this.response.template = 'oi33_migrate.html';
        this.response.body = { result, done: true };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_admin', '/oi33/admin', Oi33AdminHandler, PRIV.PRIV_MOD_BADGE);
    ctx.Route('oi33_migrate', '/oi33/migrate', MigrateHandler, PRIV.PRIV_MOD_BADGE);

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
}
