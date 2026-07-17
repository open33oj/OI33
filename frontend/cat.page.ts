import { addPage, NamedPage } from '@hydrooj/ui-default';
import { mountCats } from './oi33-cat';

addPage(new NamedPage('user_detail', mountCats));
