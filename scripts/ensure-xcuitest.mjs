import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REQUIRED_VERSION = '12.12.4';
const repoRoot = process.cwd();
const appiumHome = path.resolve(repoRoot, '.appium2');
const driverPackage = path.join(appiumHome, 'node_modules/appium-xcuitest-driver/package.json');
const appiumBin = path.resolve(repoRoot, 'node_modules/.bin', process.platform === 'win32' ? 'appium.cmd' : 'appium');

async function run(args) {
    await new Promise((resolve, reject) => {
        const child = spawn(appiumBin, args, {
            cwd: repoRoot,
            env: { ...process.env, APPIUM_HOME: appiumHome },
            stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Appium driver command failed (${signal ?? `exit ${code}`})`));
        });
    });
}

let installedVersion;
try {
    await access(driverPackage);
    installedVersion = JSON.parse(await readFile(driverPackage, 'utf8')).version;
} catch {
    installedVersion = undefined;
}

if (installedVersion === REQUIRED_VERSION) {
    console.log(`XCUITest ${REQUIRED_VERSION} is already installed in ${appiumHome}`);
    process.exit(0);
}

if (installedVersion) {
    console.log(`Replacing XCUITest ${installedVersion} with pinned ${REQUIRED_VERSION}`);
    await run(['driver', 'uninstall', 'xcuitest']);
}
await run(['driver', 'install', `xcuitest@${REQUIRED_VERSION}`]);
