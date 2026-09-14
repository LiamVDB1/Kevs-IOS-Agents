import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveTargetUdid } from './target-device.js';

function waitForExit(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
    });
}

async function endpointReady(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function waitForWda(url: string, child: ChildProcess, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`WDA supervisor exited before ${url} became ready`);
        if (await endpointReady(url)) return;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Timed out waiting for preinstalled WDA at ${url}`);
}

if (process.platform !== 'darwin') {
    throw new Error('WDA provisioning requires macOS with full Xcode. Boot this machine into macOS and run npm run wda:provision there.');
}

const udid = await resolveTargetUdid();
const baseEnv = { ...process.env, IOS_UDID: udid };
const prepareScript = fileURLToPath(new URL('./prepare.ts', import.meta.url));
const startScript = fileURLToPath(new URL('./start.ts', import.meta.url));

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

const localPort = Number.parseInt(process.env.WDA_LOCAL_PORT ?? '8100', 10);
console.log('Starting the Xcode WDA runner once so iOS installs the signed runner app');
const supervisor = spawn(process.execPath, [
    '--env-file-if-exists=.env',
    '--env-file-if-exists=.env.devices',
    '--import', 'tsx',
    startScript,
    '--udid', udid,
], {
    env: { ...baseEnv, WDA_BACKEND: 'xcode' },
    stdio: 'inherit',
});

try {
    await waitForWda(`http://127.0.0.1:${localPort}/status`, supervisor);
    console.log('WDA is reachable. The signed runner is installed on the iPhone and can now be launched from Linux via RemoteXPC.');
} finally {
    if (supervisor.exitCode === null) {
        supervisor.kill('SIGTERM');
        await Promise.race([
            waitForExit(supervisor),
            new Promise<number>((resolve) => setTimeout(() => resolve(0), 5_000)),
        ]);
        if (supervisor.exitCode === null) supervisor.kill('SIGKILL');
    }
}
