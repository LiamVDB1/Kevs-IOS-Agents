import assert from 'node:assert/strict';
import test from 'node:test';

import { isWdaUnavailable, withWdaRelaunch } from '../src/devices/wda-recover.js';
import type { ServiceResponse } from '../src/devices/wda-service-client.js';

const UDID = 'phone-1';

function fakeSupervisor(readyAfterPolls: number) {
    const calls: string[] = [];
    let polls = 0;
    const requestService = async (pathname: string, options: { method?: string } = {}): Promise<ServiceResponse> => {
        calls.push(`${options.method ?? 'GET'} ${pathname}`);
        if (pathname.endsWith('/reconnect')) return { statusCode: 200, body: '{}' };
        polls += 1;
        const wda = polls >= readyAfterPolls ? 'ready' : 'connecting';
        return { statusCode: 200, body: JSON.stringify({ devices: [{ udid: UDID, wda, message: wda }] }) };
    };
    return { calls, requestService };
}

const quiet = { sleep: async () => {}, log: () => {} };

test('only the WDA-unavailable error triggers a relaunch', () => {
    assert.equal(isWdaUnavailable(new Error('WebDriverAgent is unavailable: The operation was aborted due to timeout')), true);
    assert.equal(isWdaUnavailable(new Error('WebDriverAgent returned 500')), false);
    assert.equal(isWdaUnavailable('WebDriverAgent is unavailable'), false);
});

test('a healthy action runs once and never restarts WDA', async () => {
    const supervisor = fakeSupervisor(1);
    assert.equal(await withWdaRelaunch(UDID, async () => 'ok', { ...quiet, requestService: supervisor.requestService }), 'ok');
    assert.deepEqual(supervisor.calls, []);
});

test('a wedged WDA is relaunched, awaited and the action retried once', async () => {
    const supervisor = fakeSupervisor(2);
    let attempts = 0;
    const result = await withWdaRelaunch(UDID, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('WebDriverAgent is unavailable: The operation was aborted due to timeout');
        return 'unlocked';
    }, { ...quiet, requestService: supervisor.requestService });
    assert.equal(result, 'unlocked');
    assert.equal(attempts, 2);
    assert.deepEqual(supervisor.calls, [`POST /devices/${UDID}/reconnect`, 'GET /devices', 'GET /devices']);
});

test('other failures propagate without a restart', async () => {
    const supervisor = fakeSupervisor(1);
    await assert.rejects(withWdaRelaunch(UDID, async () => { throw new Error('Device is locked'); },
        { ...quiet, requestService: supervisor.requestService }), /Device is locked/);
    assert.deepEqual(supervisor.calls, []);
});

test('a WDA that never comes back fails with the last supervisor message', async () => {
    const supervisor = fakeSupervisor(Number.POSITIVE_INFINITY);
    let clock = 0;
    await assert.rejects(withWdaRelaunch(UDID, async () => {
        throw new Error('WebDriverAgent is unavailable: timeout');
    }, { ...quiet, requestService: supervisor.requestService, readyTimeoutMs: 20_000, now: () => (clock += 5_000) }),
    /did not come back after a restart: connecting/);
});
