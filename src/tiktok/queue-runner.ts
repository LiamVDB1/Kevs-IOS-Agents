// Assayist phone queue runner: posts due items from the lab's queue/ as public TikTok Photo Mode
// posts through the farm scheduler and writes queue/<post id>/posted.json. The contract lives in the
// lab repository (queue/README.md): items in order, only at or after post_after, at most one per slot,
// slides in manifest order, caption.txt as it is (title field + description), write only posted.json,
// write nothing on failure.
//
// Being in the queue is the lab's publication approval (it cleared plan.queue_bar and was not
// killed), so the runner submits with publishConfirmed. The scheduler itself never retries a
// photo post, and this runner never resubmits an item that may already be live.
//
//   node --env-file-if-exists=.env --import tsx src/tiktok/queue-runner.ts [--dry-run] [--post-now <post id>]
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface QueueIndex {
    schema: string;
    items: Array<{ item: string; post_after: string }>;
}

export interface QueueManifest {
    schema: string;
    post_id: string;
    post_after: string;
    kind: string;
    slides: string[];
    title?: string;
    description?: string;
    caption_file?: string;
    sound?: unknown;
}

export interface Attempt {
    /** Farm schedule id (stable); executionId becomes the execution id once known. */
    scheduleId?: string;
    executionId: string;
    submittedAt: string;
    status: 'running' | 'succeeded' | 'failed-before-post' | 'uncertain';
    /** When the execution ended; retries back off from here. */
    endedAt?: string;
    knownIdsBefore: string[];
    error?: string;
}

export interface RunnerState {
    items: Record<string, { attempts: Attempt[] }>;
}

const QUEUE_DIR = path.resolve(process.env.ASSAYIST_QUEUE_DIR ?? '/home/liamvdb/Workspace/Active/Work/Assayist-Content/queue');
const STATE_FILE = path.resolve(process.env.QUEUE_RUNNER_STATE ?? '.scheduler-data/queue-runner.json');
const FARM_URL = process.env.FARM_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? 3000}`;
const TIKTOK_HANDLE = (process.env.TIKTOK_HANDLE ?? 'assayist').replace(/^@/, '');
const TIMEZONE = process.env.QUEUE_TIMEZONE ?? 'Europe/Brussels';
const RECEIPT_TIMEOUT_MS = 20 * 60_000;
const EXECUTION_TIMEOUT_MS = 90 * 60_000;
const PHOTO_POST = { pluginId: 'com.git-agni.tiktok', taskType: 'photo-post', taskVersion: 1 };
// A failing post retries after 15, 30, then every 60 minutes, so a sick phone gets time to recover
// and is not hammered with back-to-back full attempts.
const RETRY_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000];

// ---------- pure decisions (tested) ----------

/**
 * The item to post now, or why nothing is posted. Slots are the items' post_after times: the
 * current slot began at the latest post_after that has passed, and holds at most one post.
 */
export function chooseItem(
    index: QueueIndex,
    posted: Map<string, string>,
    blocked: Set<string>,
    nowMs: number,
    forceItem?: string,
    retryAfter: Map<string, number> = new Map(),
): { item?: string; why: string } {
    if (forceItem) {
        if (!index.items.some(({ item }) => item === forceItem)) return { why: `${forceItem} is not in the queue` };
        if (posted.has(forceItem)) return { why: `${forceItem} already has posted.json` };
        if (blocked.has(forceItem)) return { why: `${forceItem} has an attempt that may already be live` };
        return { item: forceItem, why: 'forced by --post-now' };
    }
    const due = index.items.filter(({ post_after }) => Date.parse(post_after) <= nowMs);
    if (!due.length) return { why: 'nothing is due yet' };
    const slotStart = Math.max(...due.map(({ post_after }) => Date.parse(post_after)));
    const postedThisSlot = [...posted.values()].some((at) => Date.parse(at) >= slotStart);
    if (postedThisSlot) return { why: 'this slot already has a post' };
    const next = due.find(({ item }) => !posted.has(item) && !blocked.has(item));
    if (!next) return { why: 'every due item is posted or awaiting a receipt' };
    // Items go up in order, so a backing-off item holds the queue rather than being skipped.
    const notBefore = retryAfter.get(next.item);
    if (notBefore !== undefined && nowMs < notBefore) {
        return { why: `${next.item} failed recently; retrying after ${new Date(notBefore).toISOString()}` };
    }
    return { item: next.item, why: 'due' };
}

/** When an item whose last attempts failed before Post may be tried again (undefined: now). */
export function retryNotBefore(attempts: Attempt[], backoffMs: number[] = RETRY_BACKOFF_MS): number | undefined {
    let failures = 0;
    for (const attempt of [...attempts].reverse()) {
        if (attempt.status !== 'failed-before-post') break;
        failures += 1;
    }
    if (!failures) return undefined;
    const last = attempts.at(-1)!;
    const endedAt = Date.parse(last.endedAt ?? last.submittedAt);
    if (!Number.isFinite(endedAt)) return undefined;
    return endedAt + backoffMs[Math.min(failures, backoffMs.length) - 1]!;
}

/** TikTok ids carry their creation time in the top 32 bits. */
export function tiktokIdTime(id: string): number {
    return Number(BigInt(id) >> 32n) * 1000;
}

/** New ids created at or after `sinceMs` (minus clock slack), oldest first. */
export function newPostIds(ids: string[], knownBefore: Set<string>, sinceMs: number, slackMs = 120_000): string[] {
    return [...new Set(ids)]
        .filter((id) => !knownBefore.has(id) && tiktokIdTime(id) >= sinceMs - slackMs)
        .sort((a, b) => tiktokIdTime(a) - tiktokIdTime(b));
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-01T18:00:12+02:00. */
export function isoWithOffset(ms: number, timeZone = TIMEZONE): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
    const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName!.replace('GMT', '');
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** caption.txt is the title and the description; TikTok photo posts have a field for each. */
export function splitCaption(captionTxt: string, manifest: QueueManifest): { title?: string; caption: string } {
    const text = captionTxt.replace(/\s+$/, '');
    const title = manifest.title?.trim();
    const description = manifest.description?.trim() ?? '';
    if (title && title.length <= 90 && text === [title, description].filter(Boolean).join('\n\n')) {
        return { title, caption: description };
    }
    return { caption: text };
}

// ---------- effects ----------

async function readJson<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function loadState(): Promise<RunnerState> {
    try {
        return await readJson<RunnerState>(STATE_FILE);
    } catch {
        return { items: {} };
    }
}

async function saveState(state: RunnerState): Promise<void> {
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(`${STATE_FILE}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    await rename(`${STATE_FILE}.tmp`, STATE_FILE);
}

async function farm(pathname: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${FARM_URL}${pathname}`, {
        ...init,
        headers: { origin: FARM_URL, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} failed: ${response.status} ${await response.text()}`);
    return response;
}

/** Post ids on the account's public embed page (recent posts). */
async function publicPostIds(): Promise<string[]> {
    const response = await fetch(`https://www.tiktok.com/embed/@${TIKTOK_HANDLE}`, {
        headers: {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
            'accept-language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`TikTok embed page returned ${response.status}`);
    const html = await response.text();
    const ids = [
        ...html.matchAll(/(?:video|photo)(?:\/|\\u002F)+(\d{17,20})/g),
        ...html.matchAll(/"(?:id|videoId|itemId)":"(\d{17,20})"/g),
    ].map((match) => match[1]!);
    return [...new Set(ids)];
}

async function postedTimes(index: QueueIndex): Promise<Map<string, string>> {
    const posted = new Map<string, string>();
    for (const { item } of index.items) {
        const file = path.join(QUEUE_DIR, item, 'posted.json');
        if (!existsSync(file)) continue;
        const receipt = await readJson<{ posted_at: string }>(file);
        posted.set(item, receipt.posted_at);
    }
    return posted;
}

async function writeReceipt(item: string, id: string, caption: string): Promise<void> {
    const receipt = {
        video_id: id,
        url: `https://www.tiktok.com/@${TIKTOK_HANDLE}/photo/${id}`,
        posted_at: isoWithOffset(tiktokIdTime(id)),
        caption,
    };
    const file = path.join(QUEUE_DIR, item, 'posted.json');
    await writeFile(`${file}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
    console.log(`Receipt written: ${file} → ${receipt.url}`);
}

/** Find the new post for an attempt and write its receipt. -> true when written. */
async function resolveReceipt(item: string, attempt: Attempt, caption: string, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    const known = new Set(attempt.knownIdsBefore);
    const since = Date.parse(attempt.submittedAt);
    for (;;) {
        const fresh = newPostIds(await publicPostIds().catch(() => []), known, since);
        if (fresh.length === 1) {
            await writeReceipt(item, fresh[0]!, caption);
            return true;
        }
        if (fresh.length > 1) {
            throw new Error(`Several new posts appeared since ${attempt.submittedAt} (${fresh.join(', ')}); not guessing which is ${item}`);
        }
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
}

async function uploadSlides(item: string, manifest: QueueManifest): Promise<Array<{ id: string; name: string; mimeType: string }>> {
    const form = new FormData();
    for (const [index, slide] of manifest.slides.entries()) {
        const data = await readFile(path.join(QUEUE_DIR, item, slide));
        form.append(`slide${index + 1}`, new Blob([data], { type: 'image/png' }), `${String(index + 1).padStart(2, '0')}-${slide}`);
    }
    return await (await farm('/api/assets', { method: 'POST', body: form })).json() as Array<{ id: string; name: string; mimeType: string }>;
}

async function deviceUdid(): Promise<string> {
    if (process.env.QUEUE_DEVICE_UDID) return process.env.QUEUE_DEVICE_UDID;
    const devices = await (await farm('/api/devices')).json() as Array<{ udid: string; disabled?: boolean }>;
    const active = devices.filter((device) => !device.disabled);
    if (active.length !== 1) throw new Error(`Set QUEUE_DEVICE_UDID: ${active.length} active devices are registered`);
    return active[0]!.udid;
}

async function waitForExecution(scheduleId: string): Promise<{ id: string; status: string; error?: string }> {
    const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
    let seen: { id: string; status: string; error?: string } | undefined;
    while (Date.now() < deadline) {
        const body = await (await farm(`/api/executions?deviceUdid=${encodeURIComponent(await deviceUdid())}`)).json() as
            { executions?: Array<{ id: string; scheduleId: string; status: string; error?: string }> } |
            Array<{ id: string; scheduleId: string; status: string; error?: string }>;
        const executions = Array.isArray(body) ? body : body.executions ?? [];
        seen = executions.find((execution) => execution.scheduleId === scheduleId) ?? seen;
        if (seen && ['succeeded', 'failed', 'stopped', 'cancelled'].includes(seen.status)) return seen;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    return seen ?? { id: 'unknown', status: 'timeout' };
}

async function findExecution(scheduleId: string): Promise<{ id: string; status: string; error?: string } | undefined> {
    const body = await (await farm(`/api/executions?deviceUdid=${encodeURIComponent(await deviceUdid())}`)).json() as
        { executions?: Array<{ id: string; scheduleId: string; status: string; error?: string }> } |
        Array<{ id: string; scheduleId: string; status: string; error?: string }>;
    return (Array.isArray(body) ? body : body.executions ?? []).find((execution) => execution.scheduleId === scheduleId);
}

/** Record how an execution ended; anything that may have reached Post is "uncertain", never retried. */
async function settleAttempt(attempt: Attempt, execution: { id: string; status: string; error?: string }): Promise<void> {
    attempt.executionId = execution.id;
    attempt.endedAt = new Date().toISOString();
    if (execution.status === 'succeeded') {
        attempt.status = 'succeeded';
        return;
    }
    const logs = execution.id === 'unknown' ? [] : await executionLogs(execution.id).catch(() => [] as string[]);
    const reachedPost = logs.some((line) => /Tapped Post|TikTok post submitted/.test(line));
    attempt.status = reachedPost || execution.status === 'timeout' ? 'uncertain' : 'failed-before-post';
    attempt.error = execution.error ?? execution.status;
}

async function executionLogs(id: string): Promise<string[]> {
    const body = await (await farm(`/api/executions/${id}`)).json() as { logs?: Array<string | { message?: string }> };
    return (body.logs ?? []).map((line) => typeof line === 'string' ? line : line.message ?? '');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const forceIndex = args.indexOf('--post-now');
    const forceItem = forceIndex >= 0 ? args[forceIndex + 1] : undefined;

    const index = await readJson<QueueIndex>(path.join(QUEUE_DIR, 'index.json'));
    if (index.schema !== 'assayist/queue/v1') throw new Error(`Unsupported queue schema ${index.schema}`);
    const state = await loadState();

    // Resume attempts a previous run left behind, then finish receipts for those that went up.
    for (const [item, { attempts }] of Object.entries(state.items)) {
        const last = attempts.at(-1);
        if (!last || existsSync(path.join(QUEUE_DIR, item, 'posted.json'))) continue;
        if (last.status === 'running') {
            const execution = await findExecution(last.scheduleId ?? last.executionId);
            if (execution && ['succeeded', 'failed', 'stopped', 'cancelled'].includes(execution.status)) {
                await settleAttempt(last, execution);
                await saveState(state);
                console.log(`${item}: earlier execution ${execution.id} ${execution.status}`);
            }
        }
        if (last.status === 'succeeded' || last.status === 'uncertain') {
            const caption = await readFile(path.join(QUEUE_DIR, item, 'caption.txt'), 'utf8').catch(() => '');
            if (await resolveReceipt(item, last, caption.replace(/\s+$/, ''), 0)) await saveState(state);
        }
    }

    const posted = await postedTimes(index);
    const blocked = new Set(Object.entries(state.items)
        .filter(([item, { attempts }]) => !posted.has(item)
            && attempts.some((attempt) => attempt.status === 'running' || attempt.status === 'succeeded' || attempt.status === 'uncertain'))
        .map(([item]) => item));
    const retryAfter = new Map(Object.entries(state.items)
        .map(([item, { attempts }]) => [item, retryNotBefore(attempts)] as const)
        .filter((entry): entry is readonly [string, number] => entry[1] !== undefined));
    const choice = chooseItem(index, posted, blocked, Date.now(), forceItem, retryAfter);
    console.log(`Queue: ${index.items.length} item(s); ${posted.size} posted; ${choice.item ? `posting ${choice.item}` : choice.why}`);
    if (!choice.item) return;
    const item = choice.item;

    const manifest = await readJson<QueueManifest>(path.join(QUEUE_DIR, item, 'manifest.json'));
    if (manifest.schema !== 'assayist/queue-item/v1' || manifest.kind !== 'photo' || manifest.post_id !== item) {
        throw new Error(`${item}: unsupported manifest (${manifest.schema}, ${manifest.kind})`);
    }
    if (manifest.sound !== undefined && manifest.sound !== 'tiktok-suggested') {
        throw new Error(`${item}: sound ${JSON.stringify(manifest.sound)} is not supported yet (only "tiktok-suggested")`);
    }
    const captionTxt = await readFile(path.join(QUEUE_DIR, item, manifest.caption_file ?? 'caption.txt'), 'utf8');
    const { title, caption } = splitCaption(captionTxt, manifest);
    console.log(`${item}: ${manifest.slides.length} slides; title ${JSON.stringify(title ?? '')}; caption ${caption.length} chars`);
    if (dryRun) return;

    const knownIdsBefore = await publicPostIds();
    if (!knownIdsBefore.length) throw new Error('Could not read the account\'s current posts; refusing to post without a way to find the receipt');
    const assets = await uploadSlides(item, manifest);
    const udid = await deviceUdid();
    const submittedAt = new Date().toISOString();
    const schedule = await (await farm('/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            deviceUdid: udid,
            timing: { kind: 'now' },
            runWindowMinutes: 60,
            assetIds: assets.map(({ id }) => id),
            task: {
                ...PHOTO_POST,
                payload: {
                    media: assets.map(({ id, name, mimeType }) => ({ assetId: id, name, mimeType })),
                    destination: 'publish',
                    publishConfirmed: true,
                    ...(title ? { title } : {}),
                    caption,
                },
            },
        }),
    })).json() as { id: string };
    const attempt: Attempt = { scheduleId: schedule.id, executionId: schedule.id, submittedAt, status: 'running', knownIdsBefore };
    (state.items[item] ??= { attempts: [] }).attempts.push(attempt);
    await saveState(state);
    console.log(`${item}: submitted schedule ${schedule.id}`);

    const execution = await waitForExecution(schedule.id);
    await settleAttempt(attempt, execution);
    await saveState(state);
    console.log(`${item}: execution ${execution.id} ${execution.status}${attempt.error ? ` (${attempt.error})` : ''}`);
    if (attempt.status === 'failed-before-post') return;

    const found = await resolveReceipt(item, attempt, captionTxt.replace(/\s+$/, ''), RECEIPT_TIMEOUT_MS);
    await saveState(state);
    if (!found) console.log(`${item}: no new post visible yet; the next run keeps looking and will not repost`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
    await main();
}
