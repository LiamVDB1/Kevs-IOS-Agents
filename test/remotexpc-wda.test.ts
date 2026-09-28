import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteXpcWdaSupervisor, type RemoteXpcWdaRuntime } from '../src/devices/wda/remotexpc.js';

function fakeRuntime(events: string[]): RemoteXpcWdaRuntime {
    return {
        async createPortForwarder(localPort, devicePort) {
            events.push(`forwarder:${localPort}->${devicePort}`);
            return {
                async start() { events.push(`forward:start:${localPort}`); },
                async stop() { events.push(`forward:stop:${localPort}`); },
            };
        },
        async launchRunner(udid, bundleId, environment) {
            events.push(`launch:${udid}:${bundleId}:${environment.USE_PORT}:${environment.MJPEG_SERVER_PORT}`);
        },
        async terminateRunner(udid, bundleId) {
            events.push(`terminate:${udid}:${bundleId}`);
        },
    };
}

test('RemoteXPC WDA supervisor starts forwards before launching the preinstalled runner', async () => {
    const events: string[] = [];
    const supervisor = new RemoteXpcWdaSupervisor({
        udid: 'device-1',
        runnerBundleId: 'com.example.WDA.xctrunner',
        wdaLocalPort: 8103,
        wdaRemotePort: 8100,
        mjpegLocalPort: 9103,
        mjpegRemotePort: 9100,
        launchEnvironment: { USE_PORT: '8100', MJPEG_SERVER_PORT: '9100' },
        runtime: fakeRuntime(events),
    });

    await supervisor.start();
    assert.deepEqual(events, [
        'forwarder:8103->8100',
        'forwarder:9103->9100',
        'forward:start:8103',
        'forward:start:9103',
        'launch:device-1:com.example.WDA.xctrunner:8100:9100',
    ]);

    await supervisor.stop();
    assert.deepEqual(events.slice(-3), [
        'terminate:device-1:com.example.WDA.xctrunner',
        'forward:stop:9103',
        'forward:stop:8103',
    ]);
});

test('RemoteXPC WDA supervisor cleans up forwards when runner launch fails', async () => {
    const events: string[] = [];
    const runtime = fakeRuntime(events);
    runtime.launchRunner = async () => {
        events.push('launch:failed');
        throw new Error('runner unavailable');
    };
    const supervisor = new RemoteXpcWdaSupervisor({
        udid: 'device-1',
        runnerBundleId: 'com.example.WDA.xctrunner',
        wdaLocalPort: 8103,
        wdaRemotePort: 8100,
        mjpegLocalPort: 9103,
        mjpegRemotePort: 9100,
        launchEnvironment: { USE_PORT: '8100', MJPEG_SERVER_PORT: '9100' },
        runtime,
    });

    await assert.rejects(() => supervisor.start(), /runner unavailable/);
    assert.deepEqual(events.slice(-3), [
        'launch:failed',
        'forward:stop:9103',
        'forward:stop:8103',
    ]);
});

test('RemoteXPC WDA supervisor closes the XCTest session instead of killing the runner', async () => {
    const events: string[] = [];
    const runtime = fakeRuntime(events);
    runtime.launchRunner = async () => {
        events.push('session:open');
        return { async close() { events.push('session:close'); } };
    };
    const supervisor = new RemoteXpcWdaSupervisor({
        udid: 'device-1',
        runnerBundleId: 'com.example.WDA.xctrunner',
        wdaLocalPort: 8103,
        wdaRemotePort: 8100,
        mjpegLocalPort: 9103,
        mjpegRemotePort: 9100,
        launchEnvironment: { USE_PORT: '8100', MJPEG_SERVER_PORT: '9100' },
        runtime,
    });

    await supervisor.start();
    await supervisor.stop();
    assert.deepEqual(events.slice(-3), ['session:close', 'forward:stop:9103', 'forward:stop:8103']);
    assert.ok(!events.some((event) => event.startsWith('terminate:')));
});
