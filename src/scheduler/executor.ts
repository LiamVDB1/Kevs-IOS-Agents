import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';

import type { DeviceAutomation, PluginProcessSpecification, TaskExecutionContext } from '../plugin.js';
import { discoverConnectedDevices, type Device } from '../devices/discovery.js';
import { loadRegisteredDevices, type RegisteredDevice } from '../devices/registry.js';
import { passcodeForDevice } from '../devices/secrets.js';
import { WdaRemoteControl } from '../devices/wda-remote.js';
import { lastTunnelDrop, nextTunnelDropAt, requiredTunnelWindowMs, TUNNEL_SETTLE_MS, tunnelStartedAt } from '../devices/wda/tunnel-window.js';
import type { ExecutionRow } from '../database/schema.js';
import type { PluginRegistry } from '../registry.js';
import type { TaskExecutionResult } from '../types.js';
import type { SchedulerRepository } from './repository.js';

/** How often a running execution marks itself alive; far below reconcile's 5-minute minimum abandon grace. */
const HEARTBEAT_MS = 30_000;

async function endpointReady(url: string): Promise<boolean> {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok;
    } catch {
        return false;
    }
}

async function waitForDevice(
    execution: ExecutionRow,
    registered: RegisteredDevice,
    signal: AbortSignal,
    requiredWindowMs: number,
): Promise<Device> {
    const wdaPort = registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100);
    const appiumHost = process.env.APPIUM_HOST ?? '127.0.0.1';
    const appiumPort = Number(process.env.APPIUM_PORT ?? 4725);
    let lastProblem = 'device is offline';
    let loggedProblem: string | undefined;
    while (Date.now() <= execution.deadlineAt.getTime()) {
        if (signal.aborted) throw new Error('Execution stopped while waiting for the device');
        const device = (await discoverConnectedDevices()).find(({ udid }) => udid === execution.deviceUdid);
        if (!device) lastProblem = 'device is offline';
        else if (!await endpointReady(`http://127.0.0.1:${wdaPort}/status`)) lastProblem = `WDA is unavailable on port ${wdaPort}`;
        else if (!await endpointReady(`http://${appiumHost}:${appiumPort}/status`)) lastProblem = `Appium is unavailable on port ${appiumPort}`;
        else {
            // Never start a task on a tunnel that will rotate mid-run: the
            // rotation kills WDA, and posts must not retry past the Post tap.
            const startedAt = await tunnelStartedAt();
            if (startedAt === null) return device;
            if (startedAt === undefined) {
                lastProblem = 'RemoteXPC tunnel age is unknown (phone-farm-tunnel.service not active?)';
            } else {
                const now = Date.now();
                const remaining = nextTunnelDropAt(startedAt, await lastTunnelDrop(), now) - now;
                const age = now - startedAt;
                if (age < TUNNEL_SETTLE_MS) {
                    lastProblem = `waiting for WDA to relaunch on the rotated RemoteXPC tunnel (${Math.round(age / 1000)}s old)`;
                } else if (remaining >= requiredWindowMs) {
                    return device;
                } else {
                    lastProblem = `waiting for the next RemoteXPC tunnel drop to pass (${Math.max(0, Math.round(remaining / 1000))}s left, task needs ${Math.round(requiredWindowMs / 1000)}s)`;
                }
            }
        }
        if (lastProblem !== loggedProblem) {
            console.log(`Execution ${execution.id} waiting: ${lastProblem}`);
            loggedProblem = lastProblem;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`Execution window expired: ${lastProblem}`);
}

function deviceAutomation(registered: RegisteredDevice, passcode: string | undefined): DeviceAutomation {
    const udid = registered.udid;
    const remote = new WdaRemoteControl({
        deviceUdid: udid,
        wdaUrl: `http://127.0.0.1:${registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`,
        passcode,
    });
    const appRequest = async (pathname: string, bundleId: string): Promise<void> => {
        await remote.request(pathname, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bundleId }),
        });
    };
    return {
        activateApp: (bundleId) => appRequest('/wda/apps/launch', bundleId),
        terminateApp: (bundleId) => appRequest('/wda/apps/terminate', bundleId),
        pause: (milliseconds, signal) => new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, milliseconds);
            signal?.addEventListener('abort', onAbort, { once: true });
        }),
        screenshot: () => remote.getScreenshot(udid),
        tap: (x, y) => remote.performAction(udid, { type: 'tap', x, y }),
        swipe: (startX, startY, endX, endY, durationMs) => remote.performAction(udid, {
            type: 'swipe', startX, startY, endX, endY, durationMs,
        }),
    };
}

async function runPluginProcess(
    specification: PluginProcessSpecification,
    environment: NodeJS.ProcessEnv,
    signal: AbortSignal,
    onLines: (lines: string[]) => Promise<void>,
): Promise<TaskExecutionResult> {
    const child = spawn(process.execPath, [
        '--env-file-if-exists=.env', '--env-file-if-exists=.env.devices', '--import', 'tsx',
        specification.entrypoint, ...(specification.args ?? []),
    ], { cwd: process.cwd(), env: { ...environment, ...specification.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending: string[] = [];
    const append = (chunk: Buffer | string) => { pending.push(...chunk.toString().split(/\r?\n/).filter(Boolean)); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const flush = async () => {
        if (!pending.length) return;
        const lines = pending;
        pending = [];
        await onLines(lines);
    };
    const timer = setInterval(() => void flush().catch(console.error), 3_000);
    let stopped = false;
    const stop = () => {
        stopped = true;
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
        const result = await new Promise<TaskExecutionResult>((resolve) => {
            child.once('error', (error) => resolve({ exitCode: null, stopped, error: error.message }));
            child.once('exit', (exitCode, childSignal) => resolve({
                exitCode,
                stopped,
                ...(exitCode === 0 ? {} : {
                    error: childSignal ? `Plugin process stopped by ${childSignal}` : `Plugin process exited with ${exitCode}`,
                }),
            }));
        });
        await flush();
        return result;
    } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', stop);
    }
}

export async function executeAutomation(
    repository: SchedulerRepository,
    plugins: PluginRegistry,
    execution: ExecutionRow,
    attempt: number,
    signal: AbortSignal,
): Promise<TaskExecutionResult> {
    const registered = (await loadRegisteredDevices()).find(({ udid }) => udid === execution.deviceUdid);
    if (!registered) return { exitCode: null, stopped: false, error: 'Device is not registered' };
    if (Date.now() > execution.deadlineAt.getTime()) {
        return { exitCode: null, stopped: false, error: 'Execution window expired before the worker claimed the task' };
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    const stopPoll = setInterval(() => void repository.stopRequested(execution.id).then((requested) => {
        if (requested) controller.abort(new Error('Stop requested'));
    }).catch(console.error), 1_000);
    // Heartbeat for the whole execution, device wait included: the wait for a tunnel drop and WDA
    // relaunch can outlast reconcile's abandon grace, which once failed a run that then posted anyway.
    const heartbeat = setInterval(() => void repository.heartbeat(execution.id).catch(console.error), HEARTBEAT_MS);
    const stopTimers = () => { clearInterval(stopPoll); clearInterval(heartbeat); };
    let estimatedDurationMs = 10 * 60_000;
    try {
        estimatedDurationMs = plugins.task({
            pluginId: execution.pluginId, taskType: execution.taskType, taskVersion: execution.taskVersion, payload: execution.payload,
        }).estimateDurationMs(execution.payload);
    } catch { /* unknown task: the definition lookup below reports it */ }
    let device: Device;
    try {
        device = await waitForDevice(execution, registered, controller.signal, requiredTunnelWindowMs(estimatedDurationMs));
    } catch (error) {
        stopTimers();
        signal.removeEventListener('abort', forwardAbort);
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    }
    // Never start a task whose execution was finalized while it waited: whoever finalized it may
    // already have scheduled a replacement, and a post must not go up twice.
    if (!await repository.isRunning(execution.id)) {
        stopTimers();
        signal.removeEventListener('abort', forwardAbort);
        return { exitCode: null, stopped: true, error: 'Execution was finalized while waiting for the device; not starting it' };
    }
    const workspaceDirectory = await mkdtemp(`${os.tmpdir()}/phone-farm-${execution.id}-`);
    const task = { pluginId: execution.pluginId, taskType: execution.taskType, taskVersion: execution.taskVersion, payload: execution.payload };
    try {
        const definition = plugins.task(task);
        const passcode = await passcodeForDevice(device.udid);
        const environment: NodeJS.ProcessEnv = {
            ...process.env,
            IOS_UDID: device.udid,
            WDA_URL: `http://127.0.0.1:${registered.wdaLocalPort ?? Number(process.env.WDA_LOCAL_PORT ?? 8100)}`,
            ...(passcode ? { IOS_PASSCODE: passcode } : {}),
        };
        const context: TaskExecutionContext = {
            executionId: execution.id,
            attempt,
            workspaceDirectory,
            device,
            devicePluginData: registered.pluginData[execution.pluginId] ?? {},
            automation: deviceAutomation(registered, passcode),
            assets: await repository.executionAssets(execution),
            signal: controller.signal,
            log: (line) => repository.appendLogs(execution.id, attempt, [line]),
            runProcess: (specification) => runPluginProcess(specification, environment, controller.signal, (lines) => repository.appendLogs(execution.id, attempt, lines)),
            claimPipelineItem: () => repository.claimNextPipelineItem(execution.deviceUdid, execution.id),
            completePipelineItem: (id) => repository.completePipelineItem(id),
            failPipelineItem: (id, error) => repository.failPipelineItem(id, error),
        };
        return await definition.execute(context, execution.payload);
    } catch (error) {
        return { exitCode: null, stopped: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
    } finally {
        stopTimers();
        signal.removeEventListener('abort', forwardAbort);
        await rm(workspaceDirectory, { recursive: true, force: true });
    }
}
