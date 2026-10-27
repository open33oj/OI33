import { db, SystemModel, ValidationError } from 'hydrooj';
import type {
    Oi33MedalImageSize, Oi33MedalLevel, Oi33MedalRuleType,
} from '../types';
import { addLog } from '../log';
import {
    isAutomaticRuleType, medalCategoryRank, medalGroupByCategory, medalView,
} from './rules';

// Medal definitions: the `oi33_medal` collection, the accepted-problem domain
// config kept in `system`, definition CRUD, and the definition indexes. Award
// rows live in ./award, the built-in series in ./initial, migrations in
// ./migrate and the JSON import/export format in ./definitions.

export const medalColl = db.collection('oi33_medal');
export const userMedalColl = db.collection('oi33_user_medal');

const ACCEPTED_PROBLEM_DOMAINS_KEY = 'oi33.medal.accepted_problem_domains';
// The setting was stored under the 成就 name before the rename to 奖章. It is
// read as a fallback so an upgraded install keeps its configured domains even
// before /oi33/migrate has copied the value across.
const LEGACY_ACCEPTED_PROBLEM_DOMAINS_KEY = 'oi33.achievement.accepted_problem_domains';

function normalizeAcceptedDomains(values: unknown[]): string[] {
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function parseAcceptedDomains(raw: unknown): string[] {
    if (Array.isArray(raw)) return normalizeAcceptedDomains(raw);
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeAcceptedDomains(parsed);
    } catch { /* Backward-compatible plain text value. */ }
    return normalizeAcceptedDomains(raw.split(/[,，\s]+/));
}

// An empty list means every domain. The value is JSON-encoded so it remains
// portable across Hydro versions whose SystemModel value typing differs.
export function medalGetAcceptedDomains(): string[] {
    const current = parseAcceptedDomains(SystemModel.get(ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown);
    if (current.length) return current;
    return parseAcceptedDomains(SystemModel.get(LEGACY_ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown);
}

// One-shot, idempotent copy of the pre-rename setting into the new key. Called
// by /oi33/migrate; the read fallback above covers installs that have not run
// it yet.
export async function medalMigrateAcceptedDomains() {
    const legacy = parseAcceptedDomains(SystemModel.get(LEGACY_ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown);
    if (!legacy.length) return 0;
    await SystemModel.set(ACCEPTED_PROBLEM_DOMAINS_KEY, JSON.stringify(legacy));
    return legacy.length;
}

export function medalAcceptedDomainIncluded(domainId: string): boolean {
    const domains = medalGetAcceptedDomains();
    return !domains.length || domains.includes(domainId);
}

export async function medalSetAcceptedDomains(domainIds: string[], operator: number) {
    const normalized = normalizeAcceptedDomains(domainIds);
    await SystemModel.set(ACCEPTED_PROBLEM_DOMAINS_KEY, JSON.stringify(normalized));
    await addLog({
        type: 'medal', userId: operator, action: 'config_update',
        reason: normalized.join(', '),
    });
    return normalized;
}

export async function ensureMedalIndexes() {
    await Promise.all([
        medalColl.createIndex({ order: 1, _id: 1 }),
        medalColl.createIndex({ ruleType: 1, threshold: 1, order: 1 }),
        medalColl.createIndex({ ruleType: 1, order: 1 }),
        userMedalColl.createIndex({ uid: 1, medalId: 1 }, { unique: true }),
        userMedalColl.createIndex({ medalId: 1, earnedAt: -1 }),
        userMedalColl.createIndex({ earnedAt: -1 }),
    ]);
}


export async function medalGet(id: string) {
    const medal = await medalColl.findOne({ _id: id });
    return medal ? medalView(medal) : null;
}


export async function medalList() {
    const medals = await medalColl.find().sort({ order: 1, _id: 1 }).toArray();
    return medals
        .map((medal) => medalView(medal))
        .sort((a, b) => medalCategoryRank(a) - medalCategoryRank(b));
}

// Public catalogue: every medal, grouped into the four families.
export async function medalCatalogue() {
    return medalGroupByCategory(await medalList());
}

export async function medalSave(input: {
    id: string;
    name: string;
    description: string;
    rule: string;
    ruleType: Oi33MedalRuleType;
    threshold?: number;
    imageData: string;
    imageSize: Oi33MedalImageSize;
    levels?: Oi33MedalLevel[];
    order: number;
    saleable: boolean;
    operator: number;
}) {
    const now = new Date();
    const existing = await medalColl.findOne({ _id: input.id });
    const set: Record<string, any> = {
        name: input.name,
        description: input.description,
        rule: input.rule,
        ruleType: input.ruleType,
        imageData: input.imageData,
        imageSize: input.imageSize,
        order: input.order,
        saleable: input.saleable,
        updatedAt: now,
    };
    const update: Record<string, any> = {
        $set: set,
        $setOnInsert: {
            createdAt: now,
            createdBy: input.operator,
        },
    };
    const isAutomatic = isAutomaticRuleType(input.ruleType);
    if (input.ruleType === 'manual' || input.ruleType === 'certification') {
        update.$unset = { threshold: '' };
    } else if (isAutomatic) {
        // The series threshold is the top rung's threshold: kept for sorting,
        // legacy queries and display; the evaluator reads each rung's own
        // threshold instead.
        set.threshold = (input.levels || []).reduce(
            (max, item) => Math.max(max, Number(item.threshold) || 0), 0,
        ) || input.threshold;
    }
    // The level ladder exists on both upgradable families: certification
    // (manually assigned rungs) and OJ 成就奖章 (rule-driven thresholds). It is
    // explicitly removed when a series is converted into another family so no
    // stale rungs survive.
    if (input.ruleType === 'certification' || isAutomatic) {
        set.levels = (input.levels || []).slice().sort(
            (a, b) => Number(a.level) - Number(b.level),
        );
    } else {
        update.$unset = { ...(update.$unset || {}), levels: '' };
    }
    await medalColl.updateOne(
        { _id: input.id },
        update,
        { upsert: true },
    );
    await addLog({
        type: 'medal',
        userId: input.operator,
        action: existing ? 'definition_edit' : 'definition_create',
        medalId: input.id,
    });
    return await medalGet(input.id);
}


export async function medalDelete(id: string, operator: number) {
    const awards = await userMedalColl.countDocuments({ medalId: id });
    if (awards) throw new ValidationError('已有用户获得该奖章，不能删除；可以修改奖章信息。');
    const result = await medalColl.deleteOne({ _id: id });
    if (result.deletedCount) {
        await addLog({
            type: 'medal', userId: operator,
            action: 'definition_delete', medalId: id,
        });
    }
    return !!result.deletedCount;
}
