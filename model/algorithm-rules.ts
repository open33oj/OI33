// Pure helpers for the algorithm-mastery model. Kept free of hydrooj/DB imports
// so they can be unit-tested with plain `node --test`.

// Official NOI outline ids look like `2.1.1-12` (document chapter 2, item 12);
// the stored form is the dot-joined `1.1.12`. Normalising here means every
// consumer (import, migration, handlers) sees one canonical id. Registered
// items keep an `idVersion` so the migration never re-strips an already
// normalised id (an advanced-level id also starts with `2.`).
export function normalizeOutlineId(raw: unknown): string {
    return String(raw ?? '')
        .trim()
        .replace(/^2\./, '')
        .replace(/-(\d+)$/, '.$1');
}
