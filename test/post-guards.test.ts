import assert from 'node:assert/strict';
import test from 'node:test';

import { canReuseImport, firstDisplayedWithin, lockAfterRun, mediaFingerprint, thermalLabel } from '../src/tiktok/post-guards.js';

const probe = (found: boolean) => ({ isExisting: async () => found, isDisplayed: async () => found });

test('the first displayed selector wins', async () => {
    const result = await firstDisplayedWithin(async (selector) => probe(selector === 'b'), ['a', 'b', 'c'], 1_000);
    assert.equal(result.timedOut, false);
    assert.ok(result.element);
});

test('slow lookups stop at the budget and skip the remaining selectors', async () => {
    let clock = 0;
    const tried: string[] = [];
    const result = await firstDisplayedWithin(async (selector) => {
        tried.push(selector);
        clock += 70_000;
        return probe(false);
    }, ['a', 'b', 'c', 'd'], 8_000, () => clock);
    assert.deepEqual(tried, ['a']);
    assert.deepEqual(result, { timedOut: true });
});

test('a fast miss is not reported as a timeout', async () => {
    assert.deepEqual(await firstDisplayedWithin(async () => probe(false), ['a', 'b'], 8_000, () => 0), { timedOut: false });
});

test('an import is reused only for the same device, the same media and recently', () => {
    const fingerprint = mediaFingerprint(['d1', 'd2']);
    const marker = { udid: 'u', fingerprint, importedAt: '2026-10-01T12:00:00Z', assetCount: 0 };
    const now = Date.parse('2026-10-01T13:00:00Z');
    const hours = (n: number) => n * 3_600_000;
    assert.equal(canReuseImport(marker, 'u', fingerprint, now, hours(6)), true);
    assert.equal(canReuseImport(undefined, 'u', fingerprint, now, hours(6)), false);
    assert.equal(canReuseImport(marker, 'other', fingerprint, now, hours(6)), false);
    assert.equal(canReuseImport(marker, 'u', mediaFingerprint(['d2', 'd1']), now, hours(6)), false);
    assert.equal(canReuseImport(marker, 'u', fingerprint, now + hours(6), hours(6)), false);
    assert.equal(canReuseImport({ ...marker, importedAt: 'garbage' }, 'u', fingerprint, now, hours(6)), false);
});

test('thermal states read as words', () => {
    assert.equal(thermalLabel(2), 'serious');
    assert.equal(thermalLabel(undefined), 'unknown');
});

test('the phone locks after the delay, and a failed lock never throws', async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    let locks = 0;
    assert.equal(await lockAfterRun(async () => { locks += 1; }, 60_000, sleep), 'Locked the phone');
    assert.deepEqual(slept, [60_000]);
    assert.equal(locks, 1);
    assert.equal(await lockAfterRun(async () => { locks += 1; }, 0, sleep), 'Locked the phone');
    assert.deepEqual(slept, [60_000], 'no delay: no sleep');
    assert.equal(await lockAfterRun(async () => { throw new Error('WDA is down'); }, 0, sleep), 'Could not lock the phone: WDA is down');
});
