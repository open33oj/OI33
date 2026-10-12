#!/usr/bin/env node
// Type-check the project while ignoring diagnostics that originate inside
// node_modules. hydrooj and @hydrooj/ui-default ship .ts sources (not .d.ts),
// so importing them pulls their own (pre-existing) errors into the program;
// `skipLibCheck` does not cover .ts files. Project code must stay clean.
//
// Usage: node scripts/typecheck.mjs [tsconfig.json]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = process.argv[2] || 'tsconfig.json';
const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const result = spawnSync(tsc, ['-p', config, '--pretty', 'false'], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
});
const output = `${result.stdout || ''}${result.stderr || ''}`;

const DIAG = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const diagnostics = [];
let current = null;
for (const line of output.split(/\r?\n/)) {
    const match = DIAG.exec(line);
    if (match) {
        if (current) diagnostics.push(current);
        current = {
            file: match[1], line: match[2], col: match[3],
            severity: match[4], code: match[5], text: match[6], extra: [],
        };
    } else if (current && /^\s+\S/.test(line)) {
        current.extra.push(line);
    } else if (line.trim()) {
        if (current) diagnostics.push(current);
        current = null;
    }
}
if (current) diagnostics.push(current);

const isThirdParty = (file) => file.includes('node_modules');
const own = diagnostics.filter((d) => !isThirdParty(d.file));
const external = diagnostics.length - own.length;

for (const d of own) {
    console.error(`${d.file}(${d.line},${d.col}): ${d.severity} ${d.code}: ${d.text}`);
    for (const extra of d.extra) console.error(extra);
}

if (own.length) {
    console.error(`\n✗ ${own.length} type error(s) in project code (${external} third-party diagnostic(s) ignored).`);
    process.exit(1);
}
console.log(`✓ No type errors in project code.${external ? ` (${external} third-party diagnostic(s) ignored)` : ''}`);
