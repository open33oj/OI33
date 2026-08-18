import {
    db, DocumentModel, ObjectId, STATUS, SystemModel, ValidationError,
} from 'hydrooj';
import type {
    Oi33AchievementImageSize, Oi33AchievementRuleType, Oi33UserAchievement,
} from './types';
import { addLog, logColl } from './log';
import { meowAchievementPostAdd, meowDelete } from './meow';
import { userColl } from './user';

export const achievementColl = db.collection('oi33_achievement');
export const userAchievementColl = db.collection('oi33_user_achievement');

const ACCEPTED_PROBLEM_DOMAINS_KEY = 'oi33.achievement.accepted_problem_domains';

function normalizeAcceptedDomains(values: unknown[]): string[] {
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

// An empty list means every domain. The value is JSON-encoded so it remains
// portable across Hydro versions whose SystemModel value typing differs.
export function achievementGetAcceptedDomains(): string[] {
    const raw = SystemModel.get(ACCEPTED_PROBLEM_DOMAINS_KEY) as unknown;
    if (Array.isArray(raw)) return normalizeAcceptedDomains(raw);
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalizeAcceptedDomains(parsed);
    } catch { /* Backward-compatible plain text value. */ }
    return normalizeAcceptedDomains(raw.split(/[,，\s]+/));
}

export function achievementAcceptedDomainIncluded(domainId: string): boolean {
    const domains = achievementGetAcceptedDomains();
    return !domains.length || domains.includes(domainId);
}

export async function achievementSetAcceptedDomains(domainIds: string[], operator: number) {
    const normalized = normalizeAcceptedDomains(domainIds);
    await SystemModel.set(ACCEPTED_PROBLEM_DOMAINS_KEY, JSON.stringify(normalized));
    await addLog({
        type: 'achievement', userId: operator, action: 'config_update',
        reason: normalized.join(', '),
    });
    return normalized;
}

export async function ensureAchievementIndexes() {
    await Promise.all([
        achievementColl.createIndex({ order: 1, _id: 1 }),
        achievementColl.createIndex({ ruleType: 1, threshold: 1, order: 1 }),
        userAchievementColl.createIndex({ uid: 1, achievementId: 1 }, { unique: true }),
        userAchievementColl.createIndex({ achievementId: 1, earnedAt: -1 }),
        userAchievementColl.createIndex({ earnedAt: -1 }),
    ]);
}

export async function achievementGet(id: string) {
    return await achievementColl.findOne({ _id: id });
}

// Display order for achievement lists: auction (saleable) first, then manual,
// then automatic. The `order` field (and fetch order) breaks ties within a
// group via a stable sort.
export function achievementCategoryRank(achievement: any) {
    if (achievement?.saleable) return 0;
    return AUTOMATIC_RULE_TYPES.includes(achievement?.ruleType) ? 2 : 1;
}

export async function achievementList() {
    const achievements = await achievementColl.find().sort({ order: 1, _id: 1 }).toArray();
    return achievements.sort((a, b) => achievementCategoryRank(a) - achievementCategoryRank(b));
}

// Public catalogue category beside the saleable/rare achievements. Legacy
// definitions without ruleType are manual by the same convention used by the
// management UI. Saleable definitions stay exclusively in the rare section.
export async function achievementListManual() {
    return await achievementColl.find({
        saleable: { $ne: true },
        $or: [{ ruleType: 'manual' }, { ruleType: { $exists: false } }],
    }).sort({ order: 1, _id: 1 }).toArray();
}

export async function achievementSave(input: {
    id: string;
    name: string;
    description: string;
    rule: string;
    ruleType: Oi33AchievementRuleType;
    threshold?: number;
    imageData: string;
    imageSize: Oi33AchievementImageSize;
    order: number;
    saleable: boolean;
    operator: number;
}) {
    const now = new Date();
    const existing = await achievementColl.findOne({ _id: input.id });
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
    if (input.ruleType === 'manual') update.$unset = { threshold: '' };
    else set.threshold = input.threshold;
    await achievementColl.updateOne(
        { _id: input.id },
        update,
        { upsert: true },
    );
    await addLog({
        type: 'achievement',
        userId: input.operator,
        action: existing ? 'definition_edit' : 'definition_create',
        achievementId: input.id,
    });
    return await achievementColl.findOne({ _id: input.id });
}

export async function achievementDelete(id: string, operator: number) {
    const awards = await userAchievementColl.countDocuments({ achievementId: id });
    if (awards) throw new ValidationError('已有用户获得该成就，不能删除；可以修改成就信息。');
    const result = await achievementColl.deleteOne({ _id: id });
    if (result.deletedCount) {
        await addLog({
            type: 'achievement', userId: operator,
            action: 'definition_delete', achievementId: id,
        });
    }
    return !!result.deletedCount;
}

export async function achievementGetUserAwards(uid: number) {
    const grants = await userAchievementColl.find({ uid }).sort({ earnedAt: -1 }).toArray();
    if (!grants.length) return [];
    const definitions = await achievementColl.find({
        _id: { $in: grants.map((grant) => grant.achievementId) },
    }).toArray();
    const definitionMap = new Map(definitions.map((definition) => [definition._id, definition]));
    return grants
        .map((grant) => {
            const achievement = definitionMap.get(grant.achievementId);
            return achievement ? { ...grant, achievement } : null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => (
            achievementCategoryRank(a.achievement) - achievementCategoryRank(b.achievement)
            || a.achievement.order - b.achievement.order
            || a.earnedAt.getTime() - b.earnedAt.getTime()
        ));
}

export async function achievementListRecentAwards(limit = 50) {
    return await userAchievementColl.find().sort({ earnedAt: -1 }).limit(limit).toArray();
}

export interface AchievementEvaluateOptions {
    ruleTypes?: Oi33AchievementRuleType[];
    historicalCatFood?: boolean;
    announce?: boolean;
    source?: string;
}

const AUTOMATIC_RULE_TYPES: Oi33AchievementRuleType[] = [
    'accepted_problems',
    'checkin_streak',
    'checkin_total',
    'cat_food_balance',
    'cat_can_balance',
];

async function achievementGetHistoricalCatFoodPeak(uid: number, currentBalance: number) {
    let balance = currentBalance;
    let peak = currentBalance;
    const cursor = logColl.find({
        userId: uid,
        type: { $in: ['checkin', 'cat_account'] },
        amount: { $exists: true, $ne: 0 },
    }, {
        projection: { amount: 1 },
    }).sort({ createdAt: -1, _id: -1 });
    try {
        while (await cursor.hasNext()) {
            const entry = await cursor.next();
            if (!entry) break;
            // Walking newest to oldest: subtracting a transaction delta gives
            // the balance immediately before that transaction.
            balance -= Number(entry.amount) || 0;
            if (balance > peak) peak = balance;
        }
    } finally {
        await cursor.close();
    }
    return Math.max(0, peak);
}

export async function achievementEvaluateUser(
    uid: number,
    options: AchievementEvaluateOptions = {},
) {
    const ruleTypes = (options.ruleTypes || AUTOMATIC_RULE_TYPES)
        .filter((type) => type !== 'manual');
    if (!ruleTypes.length) return { checked: 0, matched: 0, granted: [] as string[] };
    const definitions = await achievementColl.find({
        ruleType: { $in: ruleTypes },
        threshold: { $gt: 0 },
    }).sort({ order: 1, threshold: 1, _id: 1 }).toArray();
    if (!definitions.length) return { checked: 0, matched: 0, granted: [] as string[] };

    const needsAccepted = definitions.some((item) => item.ruleType === 'accepted_problems');
    const user = await userColl.findOne({ _id: uid });
    // Unverified users never trigger automatic achievements.
    if ((Number(user?.realname_flag) || 0) < 1) return { checked: 0, matched: 0, granted: [] as string[] };
    const acceptedDomains = needsAccepted ? achievementGetAcceptedDomains() : [];
    const acceptedFilter: Record<string, any> = {
        docType: DocumentModel.TYPE_PROBLEM,
        uid,
        status: STATUS.STATUS_ACCEPTED,
    };
    if (acceptedDomains.length) acceptedFilter.domainId = { $in: acceptedDomains };
    const acceptedStatuses = needsAccepted
        ? await DocumentModel.collStatus.find(acceptedFilter, {
            projection: { domainId: 1, docId: 1 },
        }).toArray()
        : [];
    const acceptedRefsByDomain = new Map<string, Map<string, any>>();
    for (const status of acceptedStatuses as any[]) {
        const domainId = String(status.domainId);
        if (!acceptedRefsByDomain.has(domainId)) acceptedRefsByDomain.set(domainId, new Map());
        acceptedRefsByDomain.get(domainId)!.set(String(status.docId), status.docId);
    }
    const acceptedProblems = needsAccepted
        ? (await Promise.all([...acceptedRefsByDomain].map(([domainId, refs]) => (
            DocumentModel.coll.find({
                domainId,
                docType: DocumentModel.TYPE_PROBLEM,
                docId: { $in: [...refs.values()] },
            }, {
                projection: { sort: 1 },
            }).toArray()
        )))).flat()
        : [];
    // `sort` is the public problem number. Deliberately do not include
    // domainId here: the same sort in different configured domains is one
    // distinct problem for achievement purposes.
    const acceptedCount = new Set(acceptedProblems
        .map((item: any) => item.sort)
        .filter((sort: any) => sort !== undefined && sort !== null && String(sort) !== '')
        .map((sort: any) => String(sort))).size;
    const currentCatFood = Number(user?.cat_food) || 0;
    const catFoodValue = options.historicalCatFood
        && definitions.some((item) => item.ruleType === 'cat_food_balance')
        ? await achievementGetHistoricalCatFoodPeak(uid, currentCatFood)
        : currentCatFood;
    const values: Partial<Record<Oi33AchievementRuleType, number>> = {
        accepted_problems: acceptedCount,
        checkin_streak: Number(user?.checkin_cnt_now) || 0,
        checkin_total: Number(user?.checkin_cnt_all) || 0,
        cat_food_balance: catFoodValue,
        cat_can_balance: Number(user?.cat_can) || 0,
    };
    const granted: string[] = [];
    let matched = 0;
    for (const definition of definitions) {
        const threshold = Number(definition.threshold) || 0;
        const value = values[definition.ruleType] || 0;
        if (value < threshold) continue;
        matched++;
        const result = await achievementGrant(
            uid,
            definition._id,
            0,
            options.source
                ? `${options.source}:${definition.ruleType}`
                : `rule:${definition.ruleType}`,
            options.announce !== false,
        );
        if (result.created) granted.push(definition._id);
    }
    return { checked: definitions.length, matched, granted };
}

export async function achievementEvaluateAll() {
    const cursor = userColl.find({}, { projection: { _id: 1 } }).sort({ _id: 1 });
    let users = 0;
    let granted = 0;
    let matched = 0;
    try {
        while (await cursor.hasNext()) {
            const user = await cursor.next();
            if (!user) break;
            const result = await achievementEvaluateUser(user._id, {
                historicalCatFood: true,
                announce: false,
                source: 'scan',
            });
            users++;
            granted += result.granted.length;
            matched += result.matched;
            if (users % 50 === 0) {
                console.info(
                    `[oi33] achievement scan progress: ${users} users, `
                    + `${matched} matched, ${granted} granted`,
                );
            }
            // Keep the scan deliberately sequential and yield between users
            // so a large backfill cannot monopolize the Hydro process.
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    } finally {
        await cursor.close();
    }
    return { users, matched, granted };
}

interface InitialAchievementGroup {
    idPrefix: string;
    orderBase: number;
    ruleType: Oi33AchievementRuleType;
    thresholds: number[];
    names: string[];
    rule: (value: number) => string;
    description: (value: number) => string;
}

const INITIAL_THRESHOLDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const INITIAL_ACHIEVEMENT_IMAGES = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA6UlEQVR4AcyRgQkCMQxFy82huIMzOIkTuIErOIGTuIJDiO6h94QPoU2wPVtR+OTyr/kvV6frcfscqSnNv8NlnUZojk5vAA+j9D+A82aVJPu18qjW13PVFzC8vz2SRE8AVR6VHt+qCmAHvBDeR34TgBA2JdAq8jnTBGCgVdWAaMvI1yLVAO9qCIl83qEqACFsKtEzTJVHpce3cgEclnSYYUkeVR6VPlcBIJjDEn0+1NIXAIJbAj6dLQB2gO2/BYaAHuEs6wJ6hbuAnuEuABOIFd5SFVfEn5praThzBQCzp34DOO3uaYS4iRcAAAD//zJp41IAAAAGSURBVAMAI4Hm6TXgFL8AAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA30lEQVR4AcyRgQ0CIQxFm5tD4w7O4CRO4Aau4ARO4goOYXQPvWfyE1LgAgjmLvmhLe1/wE338/49UpPN3+m2tRGare0LIBil9QCuu41J/rbUfU150Q0wOD5eJpFjwIqIcyoChMOhoYDhvo+rAJhj6k2W8irAklFurxjQcnqgxYDap8EcFQEw5wYSOcPKfUwuJQEaZFUjplKq5vfUEwEwVTMruZpb1giAaYtRbiYChI2c/ldgFtDDnMMmAb3Mk4Ce5kkARSChqLUqeiJ+qlerOXMRgGJP/QdwOTxthHiJDwAAAP//0AWwbgAAAAZJREFUAwCKJ9rpq4UaHQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA5UlEQVR4AcyRgQ3CIBBFSefQuIMzOIkTuIErOIGTuIJDGN1D+0x+cil3kSI0bfJz8DneBzrcz/t3Tw1p/E63beqhEZ2+AQx6aT0B190mSfa28qjW17joBmw+Pl5JYg6AKo/KHN+qKMBusBCgds0bzwoAHkGjtVkB3gnxIjhrxQERJPKBo+IA72l+wYsDgAOTmLMZyVPFs3JvoGaqmoFKnjddU08WAFTNVOZqrqlZANAaULQnC7CNnP7fwDCgBZzDugGt4G5AS7gbgEmIFV6tsifip05VC2dfFoDZUssEXA7P1EO8xAcAAP//ruSLFgAAAAZJREFUAwCh0uzp5qUSbAAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA7ElEQVR4AcyRgQ3CMAwErc4BYgdmYBImYANWYAImYQWGQLAH9JBeshqjOiVBVHo5/sZ/aTpcj9tnTw02PofL2npojLY3gEUv/Q/gvFmZ5L9WHtX7Wqe+gOH97WESPQFUeVR6fK8UwA/4EEL9u2hdBSA8CsVH0bsqQHRCPIIREHqvNIBhQvxwZp0GROFA5yApAOGESfQEU+VR6fG9QgCbJW1mWJJHlUeln6oAEMxmiX46VNMXAIJrAub2FgA/wOm/BX4EtAjnsCGgVXgIaBkeAjCBeOEtVXFF/NSploYzVwAwW+o3gNPubj3ETbwAAAD//30u0rMAAAAGSURBVAMA5h7p6QWk6YkAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA40lEQVR4AcyRWwrCMBBFQ9chuDd34Lf4JX67A9eSrQjuQ3uEC0MysWlMpIXLPJq5Z5pOMcbXSE1hfs6nWxih2Tp8ACSjtB3Afb8LUvq1pT7nqr4Ag8PjGSRqhhE5fXJPVQA7iKGtl/JVAMzttmntwVYBPIOlXjWgtC19BEiRXKoG2KvRMD2JHjnRqgrAINtJ1NbkW+4CZETUMKaSejbyztbKMwCmHJaodbglZgCMW4xKMxnAHmT7X4FFQA9zlnUBvcxdQE9zF0ATiBW9VmVXxE9N1WrOXAag2VP/AVyuxzBC3MQbAAD//1LRkUsAAAAGSURBVAMA5KrtGbQrQNYAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA50lEQVR4AcyRwQnCQBREF+sQ7M0OPIsn8WwH1pJWBPvQPOHBJ7uSTdwVhWHyJ/vnJXEzDMOzpzZp/J2O19RDY3V6A7jopf8B3HbbpHxb5+je06vegIL9/ZEUswVmurleBfAwHsuZ57QIQDlPGkvJVMy9XgRwSQcWBch7ejWAZcpcrPVqQKkc6ByoCkA5ZYqZYtwMZyaPKgI4rDzMsjLDzXDmqTIAxRxWzNOlJXMGoHhJwdzZDBAXePpvgR8BLcp52CKgVXkR0LK8CCAEEkW2Vtkn4k+dam05exmAsKV+AzhfDqmH+BIvAAAA//+uR30pAAAABklEQVQDAKso/xntGbeAAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA6UlEQVR4AcyR0QkCMRBEl6tDsDc78Fv8Er/twFrSimAfek8YWJKIm5iIB8Nm57LzkrslpfSYqcXW53i42Ayt0fYCsJil/wFctxuT/G3lUb2vdegGDO9ud5PoCaDKo9Lje4UAfqAWovdAtFZtAhCeh+BJCvW1CeAHtQYoAZKvGgYwTJAGozUM6AnnECEA4dxAomeYKo9Kj+9VBbBZ0maGJXlUeVT6XAWAYDZL9PlQS18ACG4J+LS3APgBTv8t8C1gRDiHrQJGhVcBI8OrAEwgXni9Kj4RPzVXbzhzBQBzpH4DOJ33NkN8iScAAAD//xs9Fv4AAAAGSURBVAMAY1P8GS1ppRsAAAAASUVORK5CYII=',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA3klEQVR4AcyRwQkCMRBFw9Yh2JsdeBZP4tkOrGVbEexD9wkfhmSSTdZEXPhMZpL5b5Kd5nl+jdQUlu98uoURWqzDB8BilP4HcN/vgqTbKrdRe4pVN8Dg8HgGiRwD5YrUYlUBbJPMba20bgJgzrSeYW6vCeAZr9WqAbkJAZT2qgG5pwFQUhUAc6aUyEumds8FyIiow5hKqilS1zqOCQBTGiTyuKklTwAYtxisnU0AtoHpvwVmAT3MGdYF9DJ3AT3NXQBFIFbUtip5In5qrK3m9CUAij31G8DlegwjxEu8AQAA//8mtPrQAAAABklEQVQDAGKM7RlA2ZNjAAAAAElFTkSuQmCC',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA60lEQVR4AcyR4QkCMRSDHzeH4Cau4A7iWOIOruAS/hbc47xPCDzaiq+1PU4I6UubpD2n+WHzSEy2/A7no43AEm2fAhajsJ2C635ngn+tNNjrWodegPn0fJnATAAsDWZG9wgVeEMpxO+n66oCwrmpQlijCczaE1cVyCQmmFCBWXvicAFmgmSMcrigJZxLhAoI5wUCM2ZYGsyM7lEs4LCgw5gFabA0mDlFVkAwhwXm1FQzZwUE1wT8OpsVeAO3/7fwa0GPcC5bLOgVXizoGV4sQKTEA60V2SfiT03RGo4vK0DsiXUK7pebjQBf4g0AAP//98ZtrQAAAAZJREFUAwDwpvUpxojRjwAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA7klEQVR4AcyR4QnCMBCFj84huIkruIM4lriDK7iEvwX3qP2EB8cl1aQmpcLj7l5z70vrMD5s7KnBpt/hfLQemqLtA6Dppe0ArvudSf5t5VG9r77oDVg+PV8mMRNAlUdlxvcqAviFXIh/HvsqAOHcNIZ8m6sAMQgYUCk+Zy4GEEIgS154kvfVFwMI0ZIqUPVztQhAOGESM4FUeVRmfK8sgMOSDrMsyaPKozJHJQCCOSwxx6WaOQEQXBPw62wC8Avc/l/gLKBFOJfNAlqFZwEtw7MATCBeeEuVfCL+1Kil4ewlAMyWWgdwv9ysh/gSbwAAAP//Nk897gAAAAZJREFUAwD6TfIpQ8OYbQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAA30lEQVR4AcyR0Q3CMAxErc6BxCaswA6IsRA7sAJL8I3EHiUPyVIaOyVtkqqIU+PDvueGYXzJ2FODhM/pepYeCtHyA3DopX0B7seDeVE8lfkxGEVvkAvAv7w/oqIOmZNvEUADJpNJ4YXTUgSgcU6Es4TX0wTgBatXDZjbHkg1IHc1hKMiAFsiBngizoRzVlHjx3IBOsCTZgZT4aPYp05lAITGQ9Tp0JLaAAhfEvCv1wDiAbavBWYBLcJZ1gW0CncBLcNdACaQWHhrZa6IPzXV2nDmDACzpbYBPG8P6SFu4gsAAP//azgxNwAAAAZJREFUAwDjruMplq/NkQAAAABJRU5ErkJggg==',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAyklEQVR4AeyS4QnCMBCFj84huIkruIM4lriDK7iEvwX3qP2EwHF3qTEmpT9a+EjyknsvSTOMDxl7Msj0Hc5H6cFkLZ8AOr1YV8B1vwsPmtNZXHQCDIACDRpozfaLAk7Pl4AtRgOr63FRgC74tb8FfL2xoivipQButDDXZy4RBmCQYCEvxTKnM5dwARhrM8ZpcU3rAjCvMcrVuAC9kN3/G5gNaGHOZsOAVuZhQEvzMACREA1aLe6K+KmWWnPqXABiS5YJuF9u0gNu4g0AAP//j5U9KQAAAAZJREFUAwBKY9cphJFt+gAAAABJRU5ErkJggg==',
];
const INITIAL_ACHIEVEMENT_GROUPS: InitialAchievementGroup[] = [
    {
        idPrefix: 'ac', orderBase: 0, ruleType: 'accepted_problems',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '题海·初帆', '题海·试帆', '题海·扬帆', '题海·云帆',
            '题海·逐浪', '题海·踏浪', '题海·破浪', '题海·凌浪',
            '题海·巡海', '题海·驭海', '题海·镇海', '题海·瀚海',
        ],
        rule: (value) => `通过 ${value} 道题号不同的题目`,
        description: (value) => `通过 ${value} 道题号不同的题目。`,
    },
    {
        idPrefix: 'streak', orderBase: 100, ruleType: 'checkin_streak',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '长明·火种', '长明·微火', '长明·灯火', '长明·炬火',
            '长明·长夜', '长明·守夜', '长明·星夜', '长明·彻夜',
            '长明·极光', '长明·耀光', '长明·恒光', '长明·永光',
        ],
        rule: (value) => `连续登录 ${value} 天`,
        description: (value) => `连续登录 ${value} 天。`,
    },
    {
        idPrefix: 'login', orderBase: 200, ruleType: 'checkin_total',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '足迹·初步', '足迹·起步', '足迹·迈步', '足迹·阔步',
            '足迹·旅途', '足迹·远途', '足迹·长途', '足迹·征途',
            '足迹·常来', '足迹·常驻', '足迹·常年', '足迹·常伴',
        ],
        rule: (value) => `累计登录 ${value} 天`,
        description: (value) => `累计登录 ${value} 天。`,
    },
    {
        idPrefix: 'food', orderBase: 300, ruleType: 'cat_food_balance',
        thresholds: INITIAL_THRESHOLDS.map((value) => value * 1000),
        names: [
            '粮仓·初囤', '粮仓·小囤', '粮仓·成囤', '粮仓·满囤',
            '粮仓·小仓', '粮仓·成仓', '粮仓·满仓', '粮仓·丰仓',
            '粮仓·丰野', '粮仓·丰丘', '粮仓·丰山', '粮仓·永丰',
        ],
        rule: (value) => `猫粮余额曾达到 ${value / 1000} kg`,
        description: (value) => `猫粮余额曾达到 ${value / 1000} kg。`,
    },
    {
        idPrefix: 'can', orderBase: 400, ruleType: 'cat_can_balance',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '罐藏·初罐', '罐藏·双罐', '罐藏·四罐', '罐藏·满罐',
            '罐藏·入库', '罐藏·小库', '罐藏·满库', '罐藏·丰库',
            '罐藏·宝箱', '罐藏·宝库', '罐藏·宝山', '罐藏·宝藏',
        ],
        rule: (value) => `猫罐头持有量达到 ${value} 个`,
        description: (value) => `猫罐头持有量达到 ${value} 个。`,
    },
];

export async function achievementImportInitialDefinitions(operator: number) {
    const now = new Date();
    const operations: any[] = [];
    for (const group of INITIAL_ACHIEVEMENT_GROUPS) {
        for (let index = 0; index < INITIAL_THRESHOLDS.length; index++) {
            const threshold = group.thresholds[index];
            operations.push({
                updateOne: {
                    filter: { _id: `${group.idPrefix}${200 + index}` },
                    update: {
                        $set: {
                            name: group.names[index],
                            description: group.description(threshold),
                            imageData: INITIAL_ACHIEVEMENT_IMAGES[index],
                            imageSize: 24,
                            order: group.orderBase + index,
                            rule: group.rule(threshold),
                            ruleType: group.ruleType,
                            threshold,
                            updatedAt: now,
                        },
                        $setOnInsert: { createdAt: now, createdBy: operator },
                    },
                    upsert: true,
                },
            });
        }
    }
    const result = await achievementColl.bulkWrite(operations, { ordered: false });
    await addLog({
        type: 'achievement', userId: operator, action: 'initial_import',
        reason: `${operations.length} definitions`,
    });
    return {
        total: operations.length,
        inserted: result.upsertedCount || 0,
        existing: result.matchedCount || 0,
        modified: result.modifiedCount || 0,
    };
}

// This is the only entry point automatic rule evaluators should call. The
// unique index makes it safe for several evaluators/processes to race.
export async function achievementGrant(
    uid: number,
    achievementId: string,
    grantedBy = 0,
    source = 'automatic',
    announce = true,
): Promise<{ grant: Oi33UserAchievement; created: boolean }> {
    const achievement = await achievementColl.findOne({ _id: achievementId });
    if (!achievement) throw new ValidationError('成就不存在。');
    const grant: Oi33UserAchievement = {
        _id: new ObjectId(),
        uid,
        achievementId,
        earnedAt: new Date(),
        grantedBy,
        source,
    };
    try {
        await userAchievementColl.insertOne(grant);
    } catch (e: any) {
        if (e?.code !== 11000) throw e;
        const existing = await userAchievementColl.findOne({ uid, achievementId });
        if (!existing) throw e;
        return { grant: existing, created: false };
    }

    // Managers (realname_flag >= 2) do not get an automatic meow post.
    const recipient = await userColl.findOne({ _id: uid }, { projection: { realname_flag: 1 } });
    const skipAnnounce = (Number(recipient?.realname_flag) || 0) >= 2;
    if (announce && !skipAnnounce) {
        try {
            const post = await meowAchievementPostAdd(uid, achievement);
            await userAchievementColl.updateOne(
                { _id: grant._id },
                { $set: { announcementPostId: post._id } },
            );
            grant.announcementPostId = post._id;
        } catch (e) {
            await userAchievementColl.deleteOne({ _id: grant._id });
            throw e;
        }
    }
    try {
        await addLog({
            type: 'achievement', userId: uid, sender: grantedBy,
            action: 'grant', achievementId,
        });
    } catch (e) {
        console.error('[oi33] achievement grant log failed:', e);
    }
    return { grant, created: true };
}

export async function achievementRevoke(
    uid: number,
    achievementId: string,
    operator: number,
) {
    const grant = await userAchievementColl.findOne({ uid, achievementId });
    if (!grant) return false;
    await userAchievementColl.deleteOne({ _id: grant._id });
    if (grant.announcementPostId) {
        await meowDelete(grant.announcementPostId, operator);
    }
    await addLog({
        type: 'achievement', userId: uid, sender: operator,
        action: 'revoke', achievementId,
    });
    return true;
}
