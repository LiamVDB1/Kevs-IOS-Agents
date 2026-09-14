import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = process.cwd();
const appiumHome = path.resolve(repoRoot, '.appium2');
const userHome = process.env.HOME || os.homedir();
const tunnelScript = path.join(
    appiumHome,
    'node_modules/appium-xcuitest-driver/node_modules/appium-ios-remotexpc/scripts/tunnel-creation.mjs',
);

function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
        });
    });
}

if (process.platform !== 'linux') {
    throw new Error('The RemoteXPC tunnel helper is intended for the Linux host. macOS uses the Xcode WDA backend by default.');
}

try {
    await access(tunnelScript);
} catch {
    throw new Error(`RemoteXPC tunnel script is missing at ${tunnelScript}. Run npm run appium:install-driver first.`);
}

const preservedEnv = {
    ...process.env,
    HOME: userHome,
    APPIUM_HOME: appiumHome,
};

if (process.getuid?.() === 0) {
    await run(process.execPath, [tunnelScript, '--reconnect-retries', '0'], preservedEnv);
} else {
    // Elevate only the already-installed, version-pinned RemoteXPC tunnel code.
    // Do not invoke npm/npx as root.
    const sudoArgs = [
        'env',
        `HOME=${userHome}`,
        `APPIUM_HOME=${appiumHome}`,
        process.execPath,
        tunnelScript,
        '--reconnect-retries',
        '0',
    ];
    await run('sudo', sudoArgs, process.env);
}
