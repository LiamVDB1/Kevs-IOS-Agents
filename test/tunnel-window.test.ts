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
