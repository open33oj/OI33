// Homepage side-card configuration storage. The normalizers live in
// ./home-config-rules (pure, unit-tested); this module only owns the
// `oi33_home_config` document and re-exports the rules so `oi33Model.*` keeps a
// single public surface.

import { db } from 'hydrooj';
import { HOME_CONFIG_ID, fillMissingFromSeed, normalizeHomeConfig } from './home-config-rules';
import type { HomeConfigShape } from './home-config-rules';

export * from './home-config-rules';

export const homeConfigColl = db.collection('oi33_home_config');

// Idempotent read-or-seed. The first caller (a homepage render or the admin
// page, whichever comes first) imports the legacy `hydrooj.homepage` payloads;
// the insert keeps concurrent workers from clobbering each other. A document
// that is still a pure seed (never saved by an admin) is topped up whenever the
// legacy YAML has something it lacks, which self-heals an import that ran
// before the YAML was filled in.
export async function ensureHomeConfig(seed?: Partial<HomeConfigShape> | null): Promise<HomeConfigShape> {
    const existing: any = await homeConfigColl.findOne({ _id: HOME_CONFIG_ID });
    if (existing) {
        const current = normalizeHomeConfig(existing);
        if (!existing.updatedBy) {
            const { config, changed } = fillMissingFromSeed(current, seed);
            if (changed) {
                await homeConfigColl.updateOne(
                    { _id: HOME_CONFIG_ID },
                    { $set: { ...config, updatedAt: new Date() } },
                );
                return config;
            }
        }
        return current;
    }
    const fresh = normalizeHomeConfig({ ...(seed || {}), enabled: seed?.enabled ?? true });
    try {
        await homeConfigColl.insertOne({
            _id: HOME_CONFIG_ID,
            ...fresh,
            updatedAt: new Date(),
            updatedBy: 0,
        } as any);
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
    }
    const saved: any = await homeConfigColl.findOne({ _id: HOME_CONFIG_ID });
    return normalizeHomeConfig(saved || fresh);
}

export async function saveHomeConfig(raw: any, operator: number): Promise<HomeConfigShape> {
    const config = normalizeHomeConfig(raw);
    await homeConfigColl.updateOne(
        { _id: HOME_CONFIG_ID },
        { $set: { ...config, updatedAt: new Date(), updatedBy: operator } },
        { upsert: true },
    );
    return config;
}
