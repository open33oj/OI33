import { $, addPage, NamedPage, UserSelectAutoComplete } from '@hydrooj/ui-default';

addPage(new NamedPage(
    ['record_main', 'oi33_coin_inc', 'oi33_birthday_set', 'oi33_badge_create', 'oi33_realname_set', 'oi33_cat_food_grant', 'oi33_ai_access'],
    () => {
        const instance: any = UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
            clearDefaultValue: false,
        });
        // Keep Hydro's original item rendering and key rules intact. Only normalize
        // the anonymous display value after selection so forms submit a plain UID.
        const normalizeAnonymousValue = (value: string) => {
            const anonymous = /^UID\s+(\d+)$/i.exec(String(value).trim());
            if (!anonymous) return;
            const selected = instance.ref?.getSelectedItems?.()[0];
            if (!selected || Number(selected._id) !== Number(anonymous[1])) return;
            const uid = anonymous[1];
            instance.$dom.val(uid);
            instance.ref?.setQuery(uid);
        };
        if (instance) instance.onChange(normalizeAnonymousValue);
    },
));
