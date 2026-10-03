import { requestWdaService, type WdaServiceRequester } from './wda-service-client.js';
import type { WdaServiceDevicesResponse } from './wda-service-protocol.js';

// WDA can wedge with /status still answering: a long accessibility query keeps its main thread
// busy after the client gives up, so every UI call times out while the supervisor, which only
// probes /status, reports it ready. Seen 2026-10-03: every queued post failed in 20 s at the lock
// check until WDA was relaunched.
const UNAVAILABLE = /^WebDriverAgent is unavailable/;

export interface WdaRecoveryOptions {
    requestService?: WdaServiceRequester;
    readyTimeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    log?: (message: string) => void;
}

export function isWdaUnavailable(error: unknown): boolean {
    return error instanceof Error && UNAVAILABLE.test(error.message);
}

/** Asks the WDA supervisor to relaunch WDA for `udid` and waits until it reports ready. */
export async function relaunchWda(udid: string, options: WdaRecoveryOptions = {}): Promise<void> {
    const request = options.requestService ?? requestWdaService;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const devicePath = `/devices/${encodeURIComponent(udid)}`;
    const restart = await request(`${devicePath}/reconnect`, { method: 'POST', timeoutMs: 7_000 });
    if (restart.statusCode !== 200) {
        throw new Error(`WDA supervisor refused the restart (${restart.statusCode}): ${restart.body}`);
    }
    const deadline = now() + (options.readyTimeoutMs ?? 3 * 60_000);
    let lastMessage = '';
    while (now() < deadline) {
        await sleep(options.pollIntervalMs ?? 5_000);
        try {
            const response = await request('/devices', { timeoutMs: 5_000 });
            const body = JSON.parse(response.body) as WdaServiceDevicesResponse;
            const status = body.devices.find((device) => device.udid === udid);
            if (status?.wda === 'ready') return;
            lastMessage = status?.message ?? 'device not supervised';
        } catch (error) {
            lastMessage = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(`WDA did not come back after a restart: ${lastMessage}`);
}

/**
 * Runs a pre-flight WDA action and, if WDA is unavailable, relaunches it once and retries.
 * Only for steps before anything is posted: the retry repeats the action from the start.
 */
export async function withWdaRelaunch<T>(udid: string, action: () => Promise<T>, options: WdaRecoveryOptions = {}): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (!isWdaUnavailable(error)) throw error;
        (options.log ?? console.log)(`${(error as Error).message}; relaunching WDA`);
        await relaunchWda(udid, options);
        return await action();
    }
}
