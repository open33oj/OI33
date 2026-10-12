import { Context } from 'hydrooj';
import { applyUserPatches } from './user';
import { applyHomePatches } from './home';
import { applyDisplayPatches } from './display';
import { applyTemplateGuard } from './template-guard';
import { applyTokenPatches } from './token';

// All OI33 monkey-patches, grouped by the Hydro surface they touch. index.ts
// calls this once during addon startup, before any request is served.
export function applyPatches(ctx: Context) {
    applyUserPatches(ctx);
    applyHomePatches();
    applyDisplayPatches(ctx);
    applyTemplateGuard(ctx);
    applyTokenPatches(ctx);
}
