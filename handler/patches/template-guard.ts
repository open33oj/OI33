import { Context } from 'hydrooj';
import fs from 'fs';
import path from 'path';

// (f) nunjucks template-cache guard for oi33 template overrides
// Hydro's worker calls server.listen() as soon as the server service is ready
// (entry/worker.ts), long before ui-default's TemplateService finishes reading
// addon template files into its registry (async Service.init). A page rendered
// in that window compiles shared template names (components/user.html,
// layout/html5.html, ...) from ui-default's original content, and the
// production loader (noCache: false) keeps that compiled version in
// loader.cache for the rest of the process lifetime: every oi33 template
// override silently stops applying until the next restart (the ranking table
// loses the [realname] prefix, identity icons and anonymization). Guard: for
// every template oi33 ships, drop the compiled cache entry until the registry
// provably holds oi33's file content; once verified, the guard stops touching
// that name.
export function applyTemplateGuard(ctx: Context) {
    const oi33Templates: Record<string, string> = {};
    const walkTemplates = (dir: string, base = '') => {
        for (const entry of fs.readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (fs.statSync(full).isDirectory()) walkTemplates(full, path.join(base, entry));
            else oi33Templates[path.join(base, entry).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf-8');
        }
    };
    // This file lives in handler/patches/, so the templates dir is two levels up.
    walkTemplates(path.resolve(__dirname, '../../templates'));

    let templateService: any = null;
    (ctx as any).inject(['template'], (c: any) => { templateService = c.template; });

    const templateGuardStart = Date.now();
    const TEMPLATE_GUARD_TIMEOUT = 120 * 1000;
    const verifiedTemplates = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nunjucks = require('nunjucks');
    const origGetTemplate = nunjucks.Environment.prototype.getTemplate;
    nunjucks.Environment.prototype.getTemplate = function getTemplate(this: any, name: any, ...rest: any[]) {
        const key = name && name.raw ? name.raw : name;
        if (typeof key === 'string' && oi33Templates[key] !== undefined && !verifiedTemplates.has(key)) {
            for (const loader of this.loaders || []) {
                if (loader.cache) delete loader.cache[key];
            }
            if (templateService?.registry?.[key] === oi33Templates[key]
                || Date.now() - templateGuardStart > TEMPLATE_GUARD_TIMEOUT) {
                verifiedTemplates.add(key);
            }
        }
        return origGetTemplate.call(this, name, ...rest);
    };
}
