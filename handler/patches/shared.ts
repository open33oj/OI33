// Shared helpers for the OI33 monkey-patches. The cloned user keeps every OI33
// field visible to Hydro's JSON serializer while real-name data stays
// non-enumerable (see the inline notes).

// OI33 fields merged by mergeOi33Fields that should survive Hydro's JSON
// serialization. Hydro's framework serializer calls User.serialize(), which
// picks only getFields() (base fields + _publicFields), silently dropping every
// oi33 field from noTemplate JSON responses (e.g. /user/:uid via API token).
// Registering them on the clone's _publicFields makes serialize() include them;
// templates already read them directly and are unaffected.
export const OI33_SERIALIZE_FIELDS = [
    'oi33_profile_hidden',
    'coin_now', 'coin_all',
    'cat_food', 'cat_can',
    'birthday_date',
    'realname_flag', 'realname_name',
    'badge',
    'atcoder', 'atcoder_rating', 'atcoder_updated_at',
    'codeforces', 'codeforces_rating', 'codeforces_updated_at',
];

export function cloneUserForDisplay<T>(udoc: T): T {
    if (!udoc || typeof udoc !== 'object') return udoc;
    const clone: T = Object.create(
        Object.getPrototypeOf(udoc),
        Object.getOwnPropertyDescriptors(udoc),
    );
    const fields = (clone as any)._publicFields;
    if (Array.isArray(fields)) {
        (clone as any)._publicFields = fields.concat(
            OI33_SERIALIZE_FIELDS.filter((f) => !fields.includes(f)),
        );
    }
    // realname_name is sensitive: templates only render it to viewers with
    // OI33 flag >= 2. Apply the same rule to JSON serialization, otherwise
    // registering it in _publicFields above would leak real names to anyone.
    // The override MUST be non-enumerable: handlers like /home/messages spread
    // the udoc ({ ...udoc, avatarUrl }) into a plain object, and an enumerable
    // serialize would be copied along; the framework JSON serializer
    // ('serialize' in v) then calls it with the plain object as `this` and
    // crashes with "this.getFields is not a function".
    const origSerialize = (clone as any).serialize;
    if (typeof origSerialize === 'function') {
        Object.defineProperty(clone, 'serialize', {
            configurable: true,
            enumerable: false,
            writable: true,
            value: function serialize(h?: any) {
                const result = origSerialize.call(this, h);
                if (result && (Number(h?.user?.realname_flag) || 0) < 2) {
                    delete result.realname_name;
                }
                return result;
            },
        });
    }
    // Likewise, once the serialize override is lost through a spread, a
    // plain-enumerable realname_name would leak real names into JSON verbatim.
    // Define it non-enumerable up front; the later mergeOi33Fields assignment
    // keeps the attributes (writable), while templates and pick() inside
    // serialize() still read it normally.
    Object.defineProperty(clone, 'realname_name', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: (clone as any).realname_name || '',
    });
    return clone;
}
