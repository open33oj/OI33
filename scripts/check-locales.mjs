#!/usr/bin/env node
// Guards the two locale mistakes that are easy to make and expensive to notice:
//   1. a duplicated key in locales/zh.yaml (js-yaml refuses to load the whole
//      file, so *every* translation of the addon goes missing at boot), and
//   2. a template that sets a page_name for which no Chinese title is
//      registered (the browser tab then shows the raw key).
// Runs as part of `npm test`.
import { readFileSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

// Same loader (and version family) Hydro itself uses to read locales.
const yaml = createRequire(import.meta.url)('js-yaml');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localeFile = join(root, 'locales', 'zh.yaml');

let dict;
try {
    dict = yaml.load(readFileSync(localeFile, 'utf-8'));
} catch (e) {
    console.error(`✗ locales/zh.yaml failed to parse: ${e.message}`);
    process.exit(1);
}
if (!dict || typeof dict !== 'object') {
    console.error('✗ locales/zh.yaml did not parse into a mapping.');
    process.exit(1);
}

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.html')) out.push(full);
    }
    return out;
}

const pageNameRe = /\{%-?\s*set\s+page_name\s*=\s*["']([^"']+)["']/g;
const missing = new Map();
let found = 0;
for (const file of walk(join(root, 'templates'))) {
    const src = readFileSync(file, 'utf-8');
    for (const match of src.matchAll(pageNameRe)) {
        const name = match[1];
        // Core page names are translated by Hydro itself; only ours must be here.
        if (!name.startsWith('oi33_')) continue;
        found++;
        if (!(name in dict)) missing.set(name, relative(root, file));
    }
}

if (missing.size) {
    console.error(`✗ ${missing.size} oi33 page_name(s) have no Chinese title in locales/zh.yaml:`);
    for (const [name, file] of missing) console.error(`    ${name}  (used by ${file})`);
    process.exit(1);
}

console.log(`✓ locales/zh.yaml parses (${Object.keys(dict).length} keys); all ${found} oi33 page names have titles.`);
