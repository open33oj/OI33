#!/usr/bin/env node
// Type-check the project while ignoring diagnostics that originate inside
// node_modules. hydrooj and @hydrooj/ui-default ship .ts sources (not .d.ts),
// so importing them pulls their own (pre-existing) errors into the program;
// `skipLibCheck` does not cover .ts files. Project code must stay clean.
//
// Usage: node scripts/typecheck.mjs [tsconfig.json]
//
// The exit code is authoritative. A previous version only inspected parsed
// diagnostics, so a config-level error (which TS prints without a `file:line:col`
// prefix, e.g. TS5101 for a deprecated option) made the script print a green
// check while tsc had aborted before checking a single file. Anything tsc
// reports as an error that we cannot attribute to node_modules now fails.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = process.argv[2] || 'tsconfig.json';
const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const result = spawnSync(tsc, ['-p', config, '--pretty', 'false'], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
});
if (result.error) {
    console.error(`✗ failed to run tsc (${tsc}): ${result.error.message}`);
    process.exit(1);
}
const output = `${result.stdout || ''}${result.stderr || ''}`;
if (!output.trim() && result.status === 0) {
    console.log(`✓ No type errors in project code.`);
    process.exit(0);
}

// Two diagnostic shapes:
//   path/to/file.ts(12,5): error TS1234: message
//   error TS5101: message            <- config-level, no file: treat as ours
const WITH_FILE = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const NO_FILE = /^(error|warning) (TS\d+): (.*)$/;
const diagnostics = [];
let current = null;
const push = () => {
    if (current) diagnostics.push(current);
    current = null;
};
for (const line of output.split(/\r?\n/)) {
    const withFile = WITH_FILE.exec(line);
    const noFile = withFile ? null : NO_FILE.exec(line);
    const match = withFile || noFile;
    if (match) {
        push();
        current = withFile
            ? {
                file: match[1], line: match[2], col: match[3],
                severity: match[4], code: match[5], text: match[6], extra: [],
            }
            : {
                file: config, line: '', col: '',
                severity: match[1], code: match[2], text: match[3], extra: [],
            };
    } else if (current && /^\s+\S/.test(line)) {
        current.extra.push(line);
    } else if (line.trim()) {
        push();
    }
}
push();

// Only diagnostics for files inside this addon count. Checking
// `node_modules` alone is not enough: TypeScript resolves symlinks, so a
// `node_modules` symlinked to a Hydro checkout reports paths like
// `/home/nixos/Hydro/packages/ui-default/...`, which are third-party but do not
// contain `/node_modules/`.
const isThirdParty = (file) => {
    // tsc prints paths relative to the working directory (root) for files
    // outside the project, e.g. `../Hydro/packages/ui-default/hydro.ts`.
    const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
    const inside = absolute === root || absolute.startsWith(`${root}${path.sep}`);
    return !inside || absolute.includes(`${path.sep}node_modules${path.sep}`);
};
const own = diagnostics.filter((d) => !isThirdParty(d.file));
const external = diagnostics.length - own.length;

for (const d of own) {
    const where = d.line ? `${d.file}(${d.line},${d.col})` : d.file;
    console.error(`${where}: ${d.severity} ${d.code}: ${d.text}`);
    for (const extra of d.extra) console.error(extra);
}

if (own.length) {
    console.error(`\n✗ ${own.length} type error(s) in project code (${external} third-party diagnostic(s) ignored).`);
    process.exit(1);
}

// Diagnostics in a shape we do not understand must not be silently dropped:
// they are exactly how the old version turned a config error into a green check.
const unparsedErrors = output
    .split(/\r?\n/)
    .filter((line) => /error TS\d+:/.test(line) && !WITH_FILE.test(line) && !NO_FILE.test(line));
if (unparsedErrors.length) {
    console.error('✗ tsc reported diagnostics in an unexpected format:');
    for (const line of unparsedErrors) console.error(line);
    process.exit(1);
}

// tsc exits non-zero whenever *any* diagnostic exists, including the pre-existing
// ones inside the symlinked ui-default sources. That is fine as long as they were
// all filtered out — but an empty diagnostic list with a non-zero status means the
// program never got as far as checking our code.
if (result.status !== 0 && diagnostics.length === 0) {
    console.error(`✗ tsc exited with status ${result.status} but reported no diagnostics.`);
    console.error(output.trim() || '(no output)');
    process.exit(1);
}

console.log(`✓ No type errors in project code.${external ? ` (${external} third-party diagnostic(s) ignored)` : ''}`);
