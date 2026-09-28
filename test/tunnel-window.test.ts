import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredTunnelWindowMs, TUNNEL_ROTATION_MS, tunnelWindowRemainingMs } from '../src/devices/wda/tunnel-window.js';

test('a Photo Mode post needs its estimate plus margin of tunnel lifetime', () => {
    assert.equal(requiredTunnelWindowMs(8 * 60_000), 10 * 60_000);
});

test('long tasks are capped so they can still start on a fresh tunnel', () => {
    assert.equal(requiredTunnelWindowMs(60 * 60_000), 20 * 60_000);
    assert.ok(requiredTunnelWindowMs(60 * 60_000) < TUNNEL_ROTATION_MS);
});

test('remaining tunnel window counts down to the scheduled rotation', () => {
    const started = Date.UTC(2026, 8, 28, 12, 0, 0);
    assert.equal(tunnelWindowRemainingMs(started, started), TUNNEL_ROTATION_MS);
    assert.equal(tunnelWindowRemainingMs(started, started + 20 * 60_000), 5 * 60_000);
    assert.ok(tunnelWindowRemainingMs(started, started + 26 * 60_000) < 0);
});

test('systemd unix timestamps parse; anything else is unknown', async () => {
    const { parseUnixTimestamp } = await import('../src/devices/wda/tunnel-window.js');
    assert.equal(parseUnixTimestamp('@1790599996\n'), 1_790_599_996_000);
    assert.equal(parseUnixTimestamp('Mon 2026-09-28 14:53:16 CEST'), undefined);
    assert.equal(parseUnixTimestamp(''), undefined);
});

test('job expiry covers the estimate plus a full tunnel wait', async () => {
    const { jobExpirySeconds } = await import('../src/scheduler/repository.js');
    // 12-minute photo post: 720 + 600 slack + 1500 rotation + 90 settle.
    assert.equal(jobExpirySeconds(12 * 60_000), 2910);
});
