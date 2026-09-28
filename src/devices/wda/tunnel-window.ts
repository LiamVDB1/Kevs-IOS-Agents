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

/** When the running tunnel started, or undefined when no systemd-managed RemoteXPC tunnel applies. */
export async function tunnelStartedAt(): Promise<number | undefined> {
    if (process.platform !== 'linux' || resolveWdaBackend() !== 'remotexpc') return undefined;
    try {
        const { stdout } = await execFileAsync('systemctl', ['show', TUNNEL_UNIT, '-p', 'ActiveEnterTimestamp', '--value'], { timeout: 5_000 });
        const startedAt = Date.parse(stdout.trim());
        return Number.isFinite(startedAt) ? startedAt : undefined;
    } catch {
        return undefined;
    }
}
