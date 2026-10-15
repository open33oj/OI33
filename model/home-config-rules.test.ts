import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DEFAULT_HOME_LUCK_TYPE, HOME_LUCK_LEVELS, fillMissingFromSeed, legacyHomeConfigFromHomepage,
    normalizeCountdownDates, normalizeHomeColor, normalizeHomeConfig, normalizeHomeMaxDates, normalizeLuckVip,
} from './home-config-rules.ts';

test('normalizeHomeColor accepts #rrggbb and bare hex, falls back otherwise', () => {
    assert.equal(normalizeHomeColor('#ED5A65'), '#ed5a65');
    assert.equal(normalizeHomeColor('00ff00'), '#00ff00');
    assert.equal(normalizeHomeColor('  #abcdef '), '#abcdef');
    assert.equal(normalizeHomeColor('red', '#123456'), '#123456');
    assert.equal(normalizeHomeColor('', '#123456'), '#123456');
});

test('normalizeHomeConfig always yields 7 luck levels', () => {
    const config = normalizeHomeConfig({ luck_type: [{ text: '超超吉', color: '#ff0000' }] });
    assert.equal(config.luck_type.length, HOME_LUCK_LEVELS);
    assert.deepEqual(config.luck_type[0], { text: '超超吉', color: '#ff0000' });
    // blank rows fall back to the built-in ladder
    assert.equal(config.luck_type[1].text, DEFAULT_HOME_LUCK_TYPE[1].text);
    assert.equal(config.luck_type[6].color, DEFAULT_HOME_LUCK_TYPE[6].color);
});

test('normalizeLuckVip parses separators and drops junk', () => {
    assert.deepEqual(normalizeLuckVip('1, 2 3、4，4'), [1, 2, 3, 4]);
    assert.deepEqual(normalizeLuckVip([7, '8', 'x', -1, 0]), [7, 8]);
    assert.deepEqual(normalizeLuckVip(undefined), []);
});

test('normalizeCountdownDates rejects invalid or incomplete rows', () => {
    assert.deepEqual(normalizeCountdownDates([
        { name: 'NOI 2026', date: '2026-07-18' },
        { name: 'CSP', date: '2026-02-31' },
        { name: '   ', date: '2026-09-19' },
        { name: 'Bad', date: '2026/09/19' },
    ]), [{ name: 'NOI 2026', date: '2026-07-18' }]);
});

test('normalizeHomeMaxDates clamps into 1..50', () => {
    assert.equal(normalizeHomeMaxDates(5), 5);
    assert.equal(normalizeHomeMaxDates(0), 1);
    assert.equal(normalizeHomeMaxDates(999), 50);
    assert.equal(normalizeHomeMaxDates('x'), 1);
});

test('normalizeHomeConfig defaults to enabled + sidebar', () => {
    const config = normalizeHomeConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.column, 'sidebar');
    assert.equal(config.countdown.max_dates, 5);
    assert.deepEqual(config.countdown.dates, []);
    assert.equal(normalizeHomeConfig({ enabled: false, column: 'main' }).column, 'main');
    assert.equal(normalizeHomeConfig({ enabled: false }).enabled, false);
});

test('legacyHomeConfigFromHomepage imports the old YAML payloads', () => {
    const seed = legacyHomeConfigFromHomepage([
        { width: 9, bulletin: true },
        {
            width: 3,
            checkin: { luck_type: [{ text: '吉', color: '#ED5A65' }], luck_vip: [1, 2] },
            countdown: { title: '倒计时', max_dates: 3, dates: [{ name: 'NOI', date: '2026-07-18' }] },
        },
    ]);
    assert.equal(seed.enabled, true);
    assert.equal(seed.column, 'sidebar');
    assert.deepEqual(seed.luck_vip, [1, 2]);
    assert.equal(seed.luck_type.length, HOME_LUCK_LEVELS);
    assert.deepEqual(seed.countdown.dates, [{ name: 'NOI', date: '2026-07-18' }]);
    assert.equal(seed.countdown.max_dates, 3);
    // a YAML without the widget does not enable anything
    assert.deepEqual(legacyHomeConfigFromHomepage([{ width: 3, meow: 10 }]), {});
});

test('fillMissingFromSeed tops up a seed document that missed the YAML', () => {
    const seeded = normalizeHomeConfig({});  // created before the YAML had dates
    const seed = legacyHomeConfigFromHomepage([{
        width: 3,
        checkin: { luck_type: [{ text: '超吉', color: '#ff0000' }], luck_vip: [7] },
        countdown: { max_dates: 5, dates: [{ name: 'NOI 2026', date: '2026-07-18' }] },
    }]);
    const { config, changed } = fillMissingFromSeed(seeded, seed);
    assert.equal(changed, true);
    assert.deepEqual(config.countdown.dates, [{ name: 'NOI 2026', date: '2026-07-18' }]);
    assert.deepEqual(config.luck_vip, [7]);
    assert.equal(config.luck_type[0].text, '超吉');
    assert.equal(config.luck_type.length, HOME_LUCK_LEVELS);
});

test('fillMissingFromSeed never overwrites data the document already has', () => {
    const current = normalizeHomeConfig({
        luck_vip: [1],
        countdown: { dates: [{ name: '已有', date: '2026-01-01' }] },
    });
    const seed = legacyHomeConfigFromHomepage([{
        width: 3,
        checkin: { luck_vip: [9] },
        countdown: { dates: [{ name: 'YAML', date: '2026-02-02' }] },
    }]);
    const { config, changed } = fillMissingFromSeed(current, seed);
    assert.equal(changed, false);
    assert.deepEqual(config.countdown.dates, [{ name: '已有', date: '2026-01-01' }]);
    assert.deepEqual(config.luck_vip, [1]);
});
