import { $, addPage, NamedPage, UserSelectAutoComplete } from '@hydrooj/ui-default';

addPage(new NamedPage(
    ['oi33_coin_inc', 'oi33_birthday_set', 'oi33_badge_create', 'oi33_realname_set'],
    () => {
        UserSelectAutoComplete.getOrConstruct($('[name="uidOrName"]'), {
            clearDefaultValue: false,
        });
    },
));
