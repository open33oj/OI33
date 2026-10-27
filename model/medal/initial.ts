import type {
    Oi33MedalAutomaticRuleType, Oi33MedalImageSize, Oi33MedalLevel,
} from '../types';
import { addLog } from '../log';
import { medalColl } from './definition';
import { MEDAL_AUTOMATIC_SERIES, medalAutomaticRuleText } from './rules';

// The built-in OJ 成就 series (题海/长明/足迹/粮仓/罐藏) and their pixel art.
// Imported once on a fresh install (and re-runnable: it only fills gaps).

interface InitialMedalGroup {
    orderBase: number;
    ruleType: Oi33MedalAutomaticRuleType;
    thresholds: number[];
    // Full rung names, e.g. 题海·初帆. The series name is stripped when the
    // ladder is built, so an award renders as「题海 · 初帆」.
    names: string[];
    description: (value: number) => string;
}

const INITIAL_THRESHOLDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
// Exported for ./medal-definitions, which falls back to these icons when an
// imported definition carries no usable pixel art.
export const INITIAL_MEDAL_IMAGES = [
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
const INITIAL_MEDAL_GROUPS: InitialMedalGroup[] = [
    {
        orderBase: 0, ruleType: 'accepted_problems',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '题海·初帆', '题海·试帆', '题海·扬帆', '题海·云帆',
            '题海·逐浪', '题海·踏浪', '题海·破浪', '题海·凌浪',
            '题海·巡海', '题海·驭海', '题海·镇海', '题海·瀚海',
        ],
        description: (value) => `通过 ${value} 道题号不同的题目。`,
    },
    {
        orderBase: 100, ruleType: 'checkin_streak',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '长明·火种', '长明·微火', '长明·灯火', '长明·炬火',
            '长明·长夜', '长明·守夜', '长明·星夜', '长明·彻夜',
            '长明·极光', '长明·耀光', '长明·恒光', '长明·永光',
        ],
        description: (value) => `连续登录 ${value} 天。`,
    },
    {
        orderBase: 200, ruleType: 'checkin_total',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '足迹·初步', '足迹·起步', '足迹·迈步', '足迹·阔步',
            '足迹·旅途', '足迹·远途', '足迹·长途', '足迹·征途',
            '足迹·常来', '足迹·常驻', '足迹·常年', '足迹·常伴',
        ],
        description: (value) => `累计登录 ${value} 天。`,
    },
    {
        orderBase: 300, ruleType: 'cat_food_balance',
        thresholds: INITIAL_THRESHOLDS.map((value) => value * 1000),
        names: [
            '粮仓·初囤', '粮仓·小囤', '粮仓·成囤', '粮仓·满囤',
            '粮仓·小仓', '粮仓·成仓', '粮仓·满仓', '粮仓·丰仓',
            '粮仓·丰野', '粮仓·丰丘', '粮仓·丰山', '粮仓·永丰',
        ],
        description: (value) => `猫粮余额曾达到 ${value / 1000} kg。`,
    },
    {
        orderBase: 400, ruleType: 'cat_can_balance',
        thresholds: INITIAL_THRESHOLDS,
        names: [
            '罐藏·初罐', '罐藏·双罐', '罐藏·四罐', '罐藏·满罐',
            '罐藏·入库', '罐藏·小库', '罐藏·满库', '罐藏·丰库',
            '罐藏·宝箱', '罐藏·宝库', '罐藏·宝山', '罐藏·宝藏',
        ],
        description: (value) => `猫罐头持有量达到 ${value} 个。`,
    },
];

// Strip the series prefix from a legacy rung name so the award view (which
// renders「系列 · 等级」) does not repeat it.
function automaticLevelName(ruleType: Oi33MedalAutomaticRuleType, name: string): string {
    const prefix = `${MEDAL_AUTOMATIC_SERIES[ruleType].name}·`;
    const trimmed = String(name || '').trim();
    return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

// Build a series ladder out of the old one-definition-per-threshold layout,
// ordered by threshold.
export function automaticLevelsFromFlat(
    ruleType: Oi33MedalAutomaticRuleType,
    defs: any[],
): Oi33MedalLevel[] {
    return [...defs]
        .sort((a, b) => (Number(a.threshold) || 0) - (Number(b.threshold) || 0)
            || String(a._id).localeCompare(String(b._id)))
        .map((def, index) => ({
            level: index + 1,
            name: automaticLevelName(ruleType, def.name),
            description: String(def.description || '')
                || medalAutomaticRuleText(ruleType, Number(def.threshold) || 0),
            imageData: String(def.imageData || INITIAL_MEDAL_IMAGES[
                Math.min(index, INITIAL_MEDAL_IMAGES.length - 1)
            ]),
            imageSize: (Number(def.imageSize) || 24) as Oi33MedalImageSize,
            threshold: Number(def.threshold) || 0,
        }));
}

export function automaticSeriesRuleText(
    ruleType: Oi33MedalAutomaticRuleType,
    levels: Oi33MedalLevel[],
): string {
    const top = levels[levels.length - 1];
    if (!top) return MEDAL_AUTOMATIC_SERIES[ruleType].description;
    return `${medalAutomaticRuleText(ruleType, Number(top.threshold) || 0)} 起逐级自动升级`;
}

// Import the five built-in indicators as one upgradable series each. Rungs are
// the old threshold ladder, so the award for a user is the highest rung
// reached. Only missing series are created: a re-import never clobbers a ladder
// an administrator has since edited.
export async function medalImportInitialDefinitions(operator: number) {
    const now = new Date();
    const operations: any[] = INITIAL_MEDAL_GROUPS.map((group) => {
        const meta = MEDAL_AUTOMATIC_SERIES[group.ruleType];
        const levels: Oi33MedalLevel[] = group.thresholds.map((threshold, index) => ({
            level: index + 1,
            name: automaticLevelName(group.ruleType, group.names[index]),
            description: group.description(threshold),
            imageData: INITIAL_MEDAL_IMAGES[index],
            imageSize: 24 as Oi33MedalImageSize,
            threshold,
        }));
        const top = levels[levels.length - 1];
        return {
            updateOne: {
                filter: { _id: meta.id },
                update: {
                    $setOnInsert: {
                        name: meta.name,
                        description: meta.description,
                        imageData: top.imageData,
                        imageSize: 24,
                        order: group.orderBase,
                        rule: automaticSeriesRuleText(group.ruleType, levels),
                        ruleType: group.ruleType,
                        threshold: top.threshold,
                        levels,
                        saleable: false,
                        createdAt: now,
                        updatedAt: now,
                        createdBy: operator,
                    },
                },
                upsert: true,
            },
        };
    });
    const result = await medalColl.bulkWrite(operations, { ordered: false });
    await addLog({
        type: 'medal', userId: operator, action: 'initial_import',
        reason: `${operations.length} series`,
    });
    return {
        total: operations.length,
        inserted: result.upsertedCount || 0,
        existing: result.matchedCount || 0,
        modified: result.modifiedCount || 0,
    };
}

