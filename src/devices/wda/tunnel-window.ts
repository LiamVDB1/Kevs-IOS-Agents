import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveWdaBackend } from './host-mode.js';

const execFileAsync = promisify(execFile);

/**
 * iOS tears the CoreDeviceProxy tunnel down ~30 minutes after it is created,
 * taking the WDA XCTest session with it. phone-farm-tunnel.service rotates it
 * earlier (RuntimeMaxSec) so the cut happens on our schedule; keep in sync.
 */
export const TUNNEL_ROTATION_MS = 25 * 60_000;
const TUNNEL_UNIT = 'phone-farm-tunnel.service';
const MAX_REQUIRED_WINDOW_MS = 20 * 60_000;
const WINDOW_MARGIN_MS = 2 * 60_000;

/** How much tunnel lifetime a task needs before it may start on the current tunnel. */
export function requiredTunnelWindowMs(estimatedDurationMs: number): number {
    return Math.min(Math.max(estimatedDurationMs, 0) + WINDOW_MARGIN_MS, MAX_REQUIRED_WINDOW_MS);
}

export function tunnelWindowRemainingMs(startedAtMs: number, nowMs: number, rotationMs = TUNNEL_ROTATION_MS): number {
    return startedAtMs + rotationMs - nowMs;
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
