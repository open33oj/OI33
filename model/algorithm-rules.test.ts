import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOutlineId } from './algorithm-rules.ts';

test('normalizeOutlineId rewrites the official chapter/item numbering', () => {
    assert.equal(normalizeOutlineId('2.1.1-12'), '1.1.12');
    assert.equal(normalizeOutlineId('2.1.2.11-5'), '1.2.11.5');
    // Chapter number is stripped even when no item ordinal is present.
    assert.equal(normalizeOutlineId('2.1.1'), '1.1');
    // Whitespace is trimmed before matching.
    assert.equal(normalizeOutlineId('  2.3.4-7  '), '3.4.7');
});

test('normalizeOutlineId is idempotent for already-normalized ids', () => {
    assert.equal(normalizeOutlineId('1.1.12'), '1.1.12');
    assert.equal(normalizeOutlineId('1.2.11.5'), '1.2.11.5');
    // Running it twice must not strip a legitimate leading "1.".
    assert.equal(normalizeOutlineId(normalizeOutlineId('2.1.1-12')), '1.1.12');
});

test('normalizeOutlineId leaves custom and group ids alone', () => {
    // Custom item ids are `custom-<base36>-<random>`; the suffix is not numeric,
    // so the dash-ordinal rewrite must not fire.
    assert.equal(normalizeOutlineId('custom-lx3k-a1b2c3'), 'custom-lx3k-a1b2c3');
    // Deterministic group ids produced by resolveGrouping.
    assert.equal(normalizeOutlineId('c:abc'), 'c:abc');
    assert.equal(normalizeOutlineId('s:def'), 's:def');
});

test('normalizeOutlineId tolerates empty input', () => {
    assert.equal(normalizeOutlineId(undefined), '');
    assert.equal(normalizeOutlineId(null), '');
    assert.equal(normalizeOutlineId(''), '');
});
