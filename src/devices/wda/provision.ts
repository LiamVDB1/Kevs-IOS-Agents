import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTargetUdid } from './target-device.js';
import { resolveDeveloperDir } from './xcode-env.js';

function waitForExit(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
    });
}

if (process.platform !== 'darwin') {
    throw new Error('WDA provisioning requires macOS with full Xcode. Boot this machine into macOS and run npm run wda:provision there.');
}

const udid = await resolveTargetUdid();
const baseEnv = { ...process.env, IOS_UDID: udid };
const prepareScript = fileURLToPath(new URL('./prepare.ts', import.meta.url));

console.log(`Building and signing patched WebDriverAgent for ${udid}`);
const prepare = spawn(process.execPath, [
    '--env-file-if-exists=.env',
    '--env-file-if-exists=.env.devices',
    '--import', 'tsx',
    prepareScript,
    '--udid', udid,
], { env: baseEnv, stdio: 'inherit' });
const prepareCode = await waitForExit(prepare);
if (prepareCode !== 0) throw new Error(`WDA prepare failed with exit ${prepareCode}`);

// Install the signed runner directly. Starting it through the Xcode WDA
// supervisor only to get it installed depends on driver internals that move
// between XCUITest releases; devicectl is the stable Xcode interface.
const developerDir = resolveDeveloperDir();
const driverPath = path.resolve(process.env.XCUITEST_DRIVER_PATH ?? '.appium2/node_modules/appium-xcuitest-driver');
const projectPath = path.join(driverPath, 'node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj');
const xcodeEnv = { ...process.env, DEVELOPER_DIR: developerDir };
const settings = JSON.parse(execFileSync('xcodebuild', [
    '-project', projectPath,
    '-scheme', 'WebDriverAgentRunner',
    '-destination', `id=${udid}`,
    '-showBuildSettings', '-json',
    `PRODUCT_BUNDLE_IDENTIFIER=${process.env.WDA_BUNDLE_ID ?? ''}`,
], { env: xcodeEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Array<{ target: string; buildSettings: Record<string, string> }>;
const runnerSettings = settings.find(({ target }) => target === 'WebDriverAgentRunner')?.buildSettings;
if (!runnerSettings?.BUILT_PRODUCTS_DIR) throw new Error('Could not resolve the WebDriverAgentRunner build directory');
const runnerApp = path.join(runnerSettings.BUILT_PRODUCTS_DIR, 'WebDriverAgentRunner-Runner.app');

console.log(`Installing ${runnerApp} on ${udid}`);
const install = spawn('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, runnerApp], {
    env: xcodeEnv,
    stdio: 'inherit',
});
const installCode = await waitForExit(install);
if (installCode !== 0) throw new Error(`devicectl install failed with exit ${installCode}`);
console.log('The signed WDA runner is installed. On the phone, trust the developer profile under '
    + 'Settings > General > VPN & Device Management and enable Settings > Developer > Enable UI Automation. '
    + 'It can now be launched from Linux via RemoteXPC.');
