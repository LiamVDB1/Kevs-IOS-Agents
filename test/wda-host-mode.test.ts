import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveWdaBackend,
    resolveWdaRunnerBundleId,
    remoteXpcLaunchEnvironment,
} from '../src/devices/wda/host-mode.js';

test('WDA backend defaults to xcode on macOS and RemoteXPC elsewhere', () => {
    assert.equal(resolveWdaBackend({}, 'darwin'), 'xcode');
    assert.equal(resolveWdaBackend({}, 'linux'), 'remotexpc');
    assert.equal(resolveWdaBackend({}, 'win32'), 'remotexpc');
});

test('WDA backend can be explicitly selected', () => {
    assert.equal(resolveWdaBackend({ WDA_BACKEND: 'xcode' }, 'linux'), 'xcode');
    assert.equal(resolveWdaBackend({ WDA_BACKEND: 'remotexpc' }, 'darwin'), 'remotexpc');
    assert.throws(() => resolveWdaBackend({ WDA_BACKEND: 'wat' }, 'linux'), /WDA_BACKEND/);
});

test('RemoteXPC runner bundle id derives the xctrunner suffix safely', () => {
    assert.equal(
        resolveWdaRunnerBundleId({ WDA_BUNDLE_ID: 'com.example.WebDriverAgentRunner' }),
        'com.example.WebDriverAgentRunner.xctrunner',
    );
    assert.equal(
        resolveWdaRunnerBundleId({ WDA_BUNDLE_ID: 'com.example.WebDriverAgentRunner.xctrunner' }),
        'com.example.WebDriverAgentRunner.xctrunner',
    );
    assert.equal(
        resolveWdaRunnerBundleId({
            WDA_BUNDLE_ID: 'com.example.WebDriverAgentRunner',
            WDA_RUNNER_BUNDLE_ID: 'com.example.CustomRunner.xctrunner',
        }),
        'com.example.CustomRunner.xctrunner',
    );
    assert.throws(() => resolveWdaRunnerBundleId({}), /WDA_BUNDLE_ID/);
});

test('RemoteXPC launch environment preserves WDA and MJPEG ports and preview quality', () => {
    assert.deepEqual(remoteXpcLaunchEnvironment({
        wdaRemotePort: 8104,
        mjpegRemotePort: 9104,
        env: {
            MJPEG_SCALING_FACTOR: '35',
            MJPEG_SERVER_SCREENSHOT_QUALITY: '20',
        },
    }), {
        USE_PORT: '8104',
        MJPEG_SERVER_PORT: '9104',
        MJPEG_SCALING_FACTOR: '35',
        MJPEG_SERVER_SCREENSHOT_QUALITY: '20',
    });
});
