import assert from 'node:assert/strict';
import test from 'node:test';

import { nextTunnelDropAt, requiredTunnelWindowMs, TUNNEL_DROP_PERIOD_MS } from '../src/devices/wda/tunnel-window.js';

const MIN = 60_000;

test('a Photo Mode post needs its estimate plus margin of tunnel time', () => {
    assert.equal(requiredTunnelWindowMs(12 * MIN), 14 * MIN);
});

test('long tasks are capped so they can still start between drops', () => {
    assert.equal(requiredTunnelWindowMs(60 * MIN), 20 * MIN);
    assert.ok(requiredTunnelWindowMs(60 * MIN) < TUNNEL_DROP_PERIOD_MS);
});

test('the next drop follows the last observed drop on the fixed cycle', () => {
    const drop = Date.UTC(2026, 8, 28, 14, 23, 0);
    // A tunnel restarted right after the drop; the next drop is 30 minutes after it.
    assert.equal(nextTunnelDropAt(drop + 30_000, drop, drop + 5 * MIN), drop + 30 * MIN);
    // Several cycles later the prediction steps forward whole periods.
    assert.equal(nextTunnelDropAt(drop + 60 * MIN + 30_000, drop, drop + 70 * MIN), drop + 90 * MIN);
});

test('a tunnel started mid-cycle is not trusted past the cycle drop', () => {
    const drop = Date.UTC(2026, 8, 28, 15, 23, 0);
    // Restarted manually at :48 — it still drops at :53, not at :18 next hour.
    assert.equal(nextTunnelDropAt(drop + 25 * MIN, drop, drop + 26 * MIN), drop + 30 * MIN);
});

test('without an observed drop, assume one period after the tunnel started', () => {
    const start = Date.UTC(2026, 8, 28, 12, 0, 0);
    assert.equal(nextTunnelDropAt(start, undefined, start + MIN), start + TUNNEL_DROP_PERIOD_MS);
});

test('systemd unix timestamps parse; anything else is unknown', async () => {
    const { parseUnixTimestamp } = await import('../src/devices/wda/tunnel-window.js');
    assert.equal(parseUnixTimestamp('@1790599996\n'), 1_790_599_996_000);
    assert.equal(parseUnixTimestamp('Mon 2026-09-28 14:53:16 CEST'), undefined);
    assert.equal(parseUnixTimestamp(''), undefined);
});

test('job expiry covers the estimate plus a full tunnel wait', async () => {
    const { jobExpirySeconds } = await import('../src/scheduler/repository.js');
    // 12-minute photo post: 720 + 600 slack + 1800 drop cycle + 90 settle.
    assert.equal(jobExpirySeconds(12 * 60_000), 3210);
});
