import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { resolveWdaBackend } from './host-mode.js';

const execFileAsync = promisify(execFile);

/**
 * The device drops the CoreDeviceProxy tunnel on a fixed ~30-minute cycle,
 * anchored to the clock rather than to tunnel creation (observed on an
 * iPhone XR / iOS 18.7: drops at :23 and :53 whatever the tunnel's age).
 * The WDA XCTest session dies with it, so tasks are scheduled between drops.
 */
export const TUNNEL_DROP_PERIOD_MS = 30 * 60_000;
const TUNNEL_UNIT = 'phone-farm-tunnel.service';
const TUNNEL_DROPS_FILE = process.env.PHONE_FARM_TUNNEL_DROPS_FILE ?? '/var/lib/phone-farm/tunnel-drops';
const MAX_REQUIRED_WINDOW_MS = 20 * 60_000;
const WINDOW_MARGIN_MS = 2 * 60_000;

/** How much uninterrupted tunnel time a task needs before it may start. */
export function requiredTunnelWindowMs(estimatedDurationMs: number): number {
    return Math.min(Math.max(estimatedDurationMs, 0) + WINDOW_MARGIN_MS, MAX_REQUIRED_WINDOW_MS);
}

/**
 * Predict the next tunnel drop: one period after the last observed drop
 * (stepping forward whole periods), and never later than one period after
 * the current tunnel started.
 */
export function nextTunnelDropAt(tunnelStartedAtMs: number, lastDropMs: number | undefined, nowMs: number, periodMs = TUNNEL_DROP_PERIOD_MS): number {
    const byAge = tunnelStartedAtMs + periodMs;
    if (lastDropMs === undefined || lastDropMs > nowMs) return byAge;
    const periods = Math.max(1, Math.ceil((nowMs - lastDropMs) / periodMs));
    return Math.min(lastDropMs + periods * periodMs, byAge);
}

/** Last tunnel drop recorded by the watchdog (unix seconds per line), if any. */
export async function lastTunnelDrop(): Promise<number | undefined> {
    try {
        const lines = (await readFile(TUNNEL_DROPS_FILE, 'utf8')).trim().split('\n');
        const seconds = Number(lines.at(-1));
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    } catch {
        return undefined;
    }
}

/** Parse `systemctl show --timestamp=unix` output ("@1790599996"); undefined when the unit is not active. */
export function parseUnixTimestamp(value: string): number | undefined {
    const match = /^@(\d+)$/.exec(value.trim());
    return match ? Number(match[1]) * 1000 : undefined;
}

/**
 * When the running tunnel started. Returns null when no systemd-managed
 * RemoteXPC tunnel applies (macOS / Xcode backend), and undefined when it
 * applies but its age cannot be read — callers must treat that as "unknown",
 * never as "plenty of time left".
 */
export async function tunnelStartedAt(): Promise<number | null | undefined> {
    if (process.platform !== 'linux' || resolveWdaBackend() !== 'remotexpc') return null;
    try {
        const { stdout } = await execFileAsync(
            'systemctl',
            ['show', TUNNEL_UNIT, '-p', 'ActiveEnterTimestamp', '--value', '--timestamp=unix'],
            { timeout: 5_000 },
        );
        return parseUnixTimestamp(stdout);
    } catch {
        return undefined;
    }
}

/** A task may only start once WDA has had time to relaunch on a freshly rotated tunnel. */
export const TUNNEL_SETTLE_MS = 90_000;

const TUNNEL_REGISTRY_URL = process.env.REMOTEXPC_TUNNEL_REGISTRY_URL ?? 'http://127.0.0.1:42314/remotexpc/tunnels';

/**
 * Identity of the device's current RemoteXPC tunnel ("address:rsdPort"), or
 * undefined when none is registered. A new identity means the XCTest session
 * WDA runs in belongs to a dead tunnel, even if WDA's /status still answers.
 */
export async function tunnelIdentity(udid: string): Promise<string | undefined> {
    try {
        const response = await fetch(TUNNEL_REGISTRY_URL, { signal: AbortSignal.timeout(3_000) });
        const body = await response.json() as { tunnels?: Record<string, { udid?: string; address?: string; rsdPort?: number }> };
        const tunnel = Object.values(body.tunnels ?? {}).find((entry) => entry.udid === udid);
        return tunnel?.address && tunnel.rsdPort ? `${tunnel.address}:${tunnel.rsdPort}` : undefined;
    } catch {
        return undefined;
    }
}
