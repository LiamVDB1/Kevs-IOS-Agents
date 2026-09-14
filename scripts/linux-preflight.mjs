import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const rows = [];
const add = (state, name, detail) => rows.push({ state, name, detail });

function command(command, args = []) {
    return spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
}

function versionMajor(value) {
    const match = String(value).match(/(\d+)/);
    return match ? Number(match[1]) : Number.NaN;
}

async function tcpReady(port) {
    return await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
        socket.once('error', () => { clearTimeout(timer); resolve(false); });
    });
}

add(process.platform === 'linux' ? 'PASS' : 'INFO', 'Host OS', `${os.type()} ${os.release()} (${os.arch()})`);
add(versionMajor(process.versions.node) >= 22 ? 'PASS' : 'FAIL', 'Node >=22', process.version);
add(existsSync('/dev/net/tun') ? 'PASS' : 'FAIL', 'TUN device', existsSync('/dev/net/tun') ? '/dev/net/tun exists' : '/dev/net/tun missing');

const ip = command('ip', ['-Version']);
add(ip.status === 0 ? 'PASS' : 'FAIL', 'iproute2', (ip.stdout || ip.stderr || 'ip command unavailable').trim().split('\n')[0]);
const usbmuxd = command('systemctl', ['is-active', 'usbmuxd']);
add(usbmuxd.status === 0 ? 'PASS' : 'FAIL', 'usbmuxd', (usbmuxd.stdout || usbmuxd.stderr || 'unavailable').trim());

const driverPackage = path.resolve(process.env.XCUITEST_DRIVER_PATH ?? '.appium2/node_modules/appium-xcuitest-driver/package.json');
if (existsSync(driverPackage)) {
    const pkg = JSON.parse(readFileSync(driverPackage, 'utf8'));
    add(versionMajor(pkg.version) >= 12 ? 'PASS' : 'FAIL', 'XCUITest driver', `${pkg.version} at ${path.dirname(driverPackage)}`);
    const remoteXpcPackage = path.join(path.dirname(driverPackage), 'node_modules/appium-ios-remotexpc/package.json');
    if (existsSync(remoteXpcPackage)) {
        const remotePkg = JSON.parse(readFileSync(remoteXpcPackage, 'utf8'));
        add('PASS', 'RemoteXPC module', remotePkg.version);
    } else {
        add('FAIL', 'RemoteXPC module', 'appium-ios-remotexpc missing from the installed XCUITest driver');
    }
} else {
    add('MISSING', 'XCUITest driver', 'Run npm run appium:install-driver');
}

try {
    const { utilities } = require('appium-ios-device');
    const devices = await utilities.getConnectedDevices();
    if (!devices.length) {
        add('MISSING', 'USB iPhone', 'No iOS device is visible through usbmuxd');
    } else {
        add('PASS', 'USB iPhone', `${devices.length} device${devices.length === 1 ? '' : 's'} visible through usbmuxd`);
        for (const udid of devices) {
            const [name, version] = await Promise.all([
                utilities.getDeviceName(udid).catch(() => 'iPhone'),
                utilities.getOSVersion(udid).catch(() => 'unknown'),
            ]);
            const major = versionMajor(version);
            add(Number.isFinite(major) && major >= 18 ? 'PASS' : 'FAIL', `${name} iOS`, version === 'unknown' ? 'Could not read iOS version' : `${version}${major < 18 ? ' — RemoteXPC requires iOS 18+' : ''}`);
        }
    }
} catch (error) {
    add('FAIL', 'USB iPhone discovery', error instanceof Error ? error.message : String(error));
}

const strongboxPort = path.join(os.homedir(), '.local/share/appium-xcuitest-driver-nodejs/strongbox/tunnelRegistryPort');
if (existsSync(strongboxPort)) {
    const port = Number.parseInt(readFileSync(strongboxPort, 'utf8').trim(), 10);
    const ready = Number.isInteger(port) && await tcpReady(port);
    add(ready ? 'PASS' : 'MISSING', 'RemoteXPC tunnel registry', ready ? `listening on 127.0.0.1:${port}` : `registry metadata points to ${port || 'an invalid port'}, but no service is listening`);
} else {
    add('MISSING', 'RemoteXPC tunnel registry', 'Run sudo -E npm run remotexpc:tunnel with HOME preserved while the iPhone is connected');
}

if (process.env.WDA_BUNDLE_ID || process.env.WDA_RUNNER_BUNDLE_ID) {
    add('PASS', 'WDA runner identity', process.env.WDA_RUNNER_BUNDLE_ID || `${process.env.WDA_BUNDLE_ID}.xctrunner`);
} else {
    add('MISSING', 'WDA runner identity', 'Set WDA_BUNDLE_ID (or WDA_RUNNER_BUNDLE_ID) after signing WDA on macOS');
}

console.log('\nPhone Farm iOS — Linux / RemoteXPC preflight\n');
for (const row of rows) {
    console.log(`${row.state.padEnd(7)} ${row.name.padEnd(28)} ${row.detail}`);
}
const failures = rows.filter(({ state }) => state === 'FAIL').length;
const missing = rows.filter(({ state }) => state === 'MISSING').length;
console.log(`\nSummary: ${failures} failure(s), ${missing} missing/blocking item(s).`);
if (failures) process.exitCode = 1;
