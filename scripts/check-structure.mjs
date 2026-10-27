#!/usr/bin/env node
// Structural gate for the addon. The checks here encode conventions that are
// cheap to verify statically and expensive to notice at runtime:
//
//   1. routes: every `ctx.Route` / `ctx.Connection` name is unique, every name
//      is `oi33_*`, every path lives under `/oi33` (legacy aliases excepted),
//      and every module that registers routes exports `apply()` and is wired
//      into `index.ts`. This is what keeps "add a feature" a local change.
//   2. templates: every `this.response.template` and every `{% include %}` /
//      `{% extends %}` resolves to a local template or a Hydro core one.
//   3. model barrel: every namespace imported by `model/index.ts` exists and is
//      spread into `oi33Model`, and nothing is spread twice. A new model module
//      that is not wired into the barrel is invisible to `global.Hydro.model`.
//   4. rule modules: every `*-rules.ts` ships a sibling `.test.ts`, so the
//      pure-logic testing convention cannot quietly rot.
//
// Usage:
//   node scripts/check-structure.mjs           # run all checks
//   node scripts/check-structure.mjs --routes  # print the route manifest (JSON)
import { readFileSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const rel = (file) => relative(root, file).split(sep).join('/');
const read = (file) => readFileSync(file, 'utf-8');
const exists = (file) => {
    try {
        statSync(file);
        return true;
    } catch {
        return false;
    }
};

function walk(dir, ext, out = []) {
    if (!exists(dir)) return out;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, ext, out);
        else if (!ext || entry.endsWith(ext)) out.push(full);
    }
    return out;
}

// --- 1. routes -------------------------------------------------------------
const ROUTE = /ctx\.(Route|Connection)\(\s*'([^']+)'\s*,\s*'([^']+)'/g;
// Deliberately not `oi33_*` / not under `/oi33`: the one legacy alias kept for
// old paste links. Add an entry here (with a reason) if another one is needed.
const ROUTE_NAME_ALLOW = new Set(['paste_show_legacy']);
const ROUTE_PATH_ALLOW = new Set(['/paste/show/:id']);

const routeFiles = [...walk(join(root, 'handler'), '.ts'), join(root, 'index.ts')];
const routes = [];
for (const file of routeFiles) {
    const src = read(file);
    for (const match of src.matchAll(ROUTE)) {
        routes.push({ kind: match[1], name: match[2], path: match[3], file: rel(file) });
    }
}
const byName = new Map();
const byPath = new Map();
for (const route of routes) {
    if (byName.has(route.name)) {
        fail(`duplicate route name "${route.name}" in ${byName.get(route.name)} and ${route.file}`);
    } else byName.set(route.name, route.file);
    const key = `${route.kind} ${route.path}`;
    if (byPath.has(key)) {
        fail(`duplicate ${route.kind} path "${route.path}" in ${byPath.get(key)} and ${route.file}`);
    } else byPath.set(key, route.file);
    if (!route.name.startsWith('oi33_') && !ROUTE_NAME_ALLOW.has(route.name)) {
        fail(`route name "${route.name}" in ${route.file} must start with oi33_`);
    }
    if (!route.path.startsWith('/oi33') && !ROUTE_PATH_ALLOW.has(route.path)) {
        fail(`route path "${route.path}" in ${route.file} must live under /oi33`);
    }
}

if (args.has('--routes')) {
    const manifest = routes
        .map(({ kind, name, path }) => ({ kind, name, path }))
        .sort((a, b) => (a.kind + a.path + a.name).localeCompare(b.kind + b.path + b.name));
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(0);
}

// Every module that registers routes must be reachable from the addon entry,
// and feature entries must expose `apply()`. Reachability (rather than a direct
// import in index.ts) is what lets `handler/cat/index.ts` fan out to its
// sub-features while still being mounted from one place.
const entryFile = join(root, 'index.ts');
const allSources = [...walk(join(root, 'handler'), '.ts'), join(root, 'model/index.ts')];
const resolveSpec = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = join(dirname(fromFile), spec);
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
        if (exists(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
};
const importGraph = new Map();
for (const file of [entryFile, ...allSources]) {
    const specs = [...read(file).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    importGraph.set(file, specs.map((spec) => resolveSpec(file, spec)).filter(Boolean));
}
const reachable = new Set();
const queue = [entryFile];
while (queue.length) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const next of importGraph.get(file) || []) queue.push(next);
}
for (const file of routeFiles) {
    const src = read(file);
    if (!/ctx\.(Route|Connection)\(/.test(src)) continue;
    if (!reachable.has(file)) {
        fail(`${rel(file)} registers routes but is not reachable from index.ts`);
        continue;
    }
    const exportsApply = /export\s+(async\s+)?function\s+apply\b/.test(src);
    const importedByEntry = (importGraph.get(entryFile) || []).includes(file);
    if (exportsApply && !importedByEntry) {
        // Exporting `apply` means "this is a feature entry"; index.ts must mount it
        // (directly, or through a feature barrel such as handler/cat/index.ts).
        const mountedByEntry = reachable.has(file)
            && [...reachable].some((parent) => (importGraph.get(parent) || []).includes(file)
                && /export\s+(async\s+)?function\s+apply\b/.test(read(parent)));
        if (!mountedByEntry) fail(`${rel(file)} exports apply() but no reachable entry imports it`);
    }
    if (!exportsApply) {
        const registeredByEntry = [...reachable].some((parent) => (importGraph.get(parent) || []).includes(file)
            && /ctx\.(Route|Connection)\(/.test(read(parent)));
        if (!registeredByEntry) {
            fail(`${rel(file)} registers routes but no route-registering entry imports it`);
        }
    }
}

// --- 2. templates ----------------------------------------------------------
// Template includes may target non-HTML assets too (`partials/problem_default.md`).
const localTemplates = new Set(walk(join(root, 'templates')).map(rel).map((p) => p.replace(/^templates\//, '')));
const coreTemplates = (() => {
    const candidates = [];
    try {
        candidates.push(join(dirname(require.resolve('@hydrooj/ui-default/package.json')), 'templates'));
    } catch {
        // package may not be installed in a bare checkout; the other candidates cover it
    }
    candidates.push(join(root, 'node_modules', '@hydrooj', 'ui-default', 'templates'));
    for (const candidate of candidates) {
        if (exists(candidate)) {
            return new Set(walk(candidate).map((p) => relative(candidate, p).split(sep).join('/')));
        }
    }
    return null;
})();

function resolveTemplate(name) {
    if (localTemplates.has(name)) return 'local';
    if (coreTemplates?.has(name)) return 'core';
    if (!coreTemplates && !/oi33|^partials\/oi33|^components\/oi33|^layout\/oi33/.test(name)) return 'unknown';
    return null;
}

for (const file of [...walk(join(root, 'handler'), '.ts'), join(root, 'index.ts')]) {
    for (const match of read(file).matchAll(/this\.response\.template\s*=\s*'([^']+)'/g)) {
        if (!resolveTemplate(match[1])) fail(`${rel(file)} renders missing template "${match[1]}"`);
    }
}
for (const file of walk(join(root, 'templates'), '.html')) {
    for (const match of read(file).matchAll(/\{%-?\s*(?:include|extends)\s+['"]([^'"]+)['"]/g)) {
        if (!resolveTemplate(match[1])) fail(`${rel(file)} includes missing template "${match[1]}"`);
    }
}

// --- 3. model barrel -------------------------------------------------------
const barrelPath = join(root, 'model', 'index.ts');
const barrel = read(barrelPath);
const nsImports = new Map();
for (const match of barrel.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+'\.\/([^']+)'/g)) {
    nsImports.set(match[1], match[2]);
}
const barrelBody = barrel.slice(barrel.indexOf('const oi33Model = {'), barrel.indexOf('};', barrel.indexOf('const oi33Model = {')));
const spreads = new Map();
for (const match of barrelBody.matchAll(/\.\.\.(\w+)/g)) {
    spreads.set(match[1], (spreads.get(match[1]) || 0) + 1);
}
for (const [name, path] of nsImports) {
    const target = join(root, 'model', path);
    if (!exists(target) && !exists(`${target}.ts`) && !exists(join(target, 'index.ts'))) {
        fail(`model/index.ts imports missing module ./${path}`);
    }
    if (!spreads.has(name)) fail(`model/index.ts imports ${name} from ./${path} but never spreads it into oi33Model`);
}
for (const [name, count] of spreads) {
    if (!nsImports.has(name)) fail(`model/index.ts spreads ${name} but never imports it`);
    if (count > 1) fail(`model/index.ts spreads ${name} ${count} times (later spread silently wins)`);
}

// --- 4. feature directories expose an index --------------------------------
// A folder under model/ or handler/ is a feature package; its public entry is
// `index.ts`. This keeps `import './cat'` meaningful and gives every feature a
// single place to look for its API.
for (const dir of ['model', 'handler']) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules') continue;
        if (!exists(join(root, dir, entry.name, 'index.ts'))) {
            fail(`${dir}/${entry.name}/ is a feature directory without an index.ts`);
        }
    }
}

// --- 5. rule modules ship tests -------------------------------------------
for (const file of walk(join(root, 'model'), '.ts')) {
    const base = file.replace(/\.ts$/, '');
    if (!/(^|\/)([a-z0-9-]*-)?rules\.ts$/.test(base)) continue;
    if (!exists(`${base}.test.ts`)) fail(`${rel(file)} has no sibling ${rel(base)}.test.ts`);
}

// --- report ---------------------------------------------------------------
for (const message of warnings) console.warn(`! ${message}`);
if (errors.length) {
    for (const message of errors) console.error(`✗ ${message}`);
    console.error(`\n✗ structure check failed with ${errors.length} error(s).`);
    process.exit(1);
}
console.log(
    `✓ structure: ${routes.length} routes (${routes.filter((r) => r.kind === 'Connection').length} connections), `
    + `${localTemplates.size} templates, ${nsImports.size} model namespaces, `
    + `${coreTemplates ? 'core templates resolved' : 'core templates unavailable (skipped)'}.`,
);
