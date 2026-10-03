// Pure guards for the TikTok post flow (src/tiktok/post.ts runs as a script, so its decisions
// that need tests live here).
import { createHash } from 'node:crypto';

export interface ElementProbe {
    isExisting(): Promise<boolean>;
    isDisplayed(): Promise<boolean>;
}

/**
 * First displayed element among `selectors`, giving up once `budgetMs` has passed. A hot or
 * saturated phone can take a minute per accessibility query; past the budget the remaining
 * selectors are skipped so the caller can fall back (e.g. to OCR) instead of stalling WDA.
 */
export async function firstDisplayedWithin<T extends ElementProbe>(
    find: (selector: string) => Promise<T>,
    selectors: string[],
    budgetMs: number,
    now: () => number = Date.now,
): Promise<{ element?: T; timedOut: boolean }> {
    const startedAt = now();
    for (const selector of selectors) {
        if (now() - startedAt >= budgetMs) return { timedOut: true };
        const candidate = await find(selector);
        if (await candidate.isExisting() && await candidate.isDisplayed()) return { element: candidate, timedOut: false };
    }
    return { timedOut: now() - startedAt >= budgetMs };
}

/** Content fingerprint of the media set, in order. Names and asset ids change per upload; bytes do not. */
export function mediaFingerprint(digests: string[]): string {
    return createHash('sha256').update(digests.join('\n')).digest('hex');
}

export interface ImportMarker {
    udid: string;
    fingerprint: string;
    importedAt: string;
    assetCount: number;
}

/**
 * Whether the media the phone imported last is exactly this set, recently enough to still be
 * the newest items in Photos Recents. A retry then reuses it instead of piling up duplicates.
 */
export function canReuseImport(
    marker: ImportMarker | undefined,
    udid: string,
    fingerprint: string,
    nowMs: number,
    maxAgeMs: number,
): boolean {
    if (!marker || marker.udid !== udid || marker.fingerprint !== fingerprint) return false;
    const age = nowMs - Date.parse(marker.importedAt);
    return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

/** ProcessInfo.ThermalState: 0 nominal, 1 fair, 2 serious, 3 critical. */
export const THERMAL_SERIOUS = 2;
export const THERMAL_CRITICAL = 3;

export function thermalLabel(state: number | undefined): string {
    return ['nominal', 'fair', 'serious', 'critical'][state ?? -1] ?? 'unknown';
}

// WDA can stay busy for minutes after the last TikTok query of a run (2026-10-03: a hung
// post-publish lookup left it unavailable for ~2 min), so a single lock attempt left the
// screen on all evening. Locking is idempotent, so retrying is safe.
export const LOCK_RETRY_DELAYS_MS = [30_000, 60_000, 90_000];

/**
 * Lock the phone once a post run is over, after `delayMs`, retrying after each of
 * `retryDelaysMs`. Never throws: a failed lock must not turn a finished post into a failed one.
 * -> the line to log.
 */
export async function lockAfterRun(
    lock: () => Promise<void>,
    delayMs: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retryDelaysMs: readonly number[] = LOCK_RETRY_DELAYS_MS,
): Promise<string> {
    if (delayMs > 0) await sleep(delayMs);
    let lastError: unknown;
    for (const [attempt, retryDelay] of [0, ...retryDelaysMs].entries()) {
        if (retryDelay > 0) await sleep(retryDelay);
        try {
            await lock();
            return attempt === 0 ? 'Locked the phone' : `Locked the phone after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`;
        } catch (error) {
            lastError = error;
        }
    }
    return `Could not lock the phone: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
}
