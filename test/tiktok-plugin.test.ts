import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../src/registry.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';

const plugin = createTikTokPlugin({ doomscrollEntrypoint: '/example/doomscroll.js', postEntrypoint: '/example/post.js' });

test('built-in TikTok plugin validates versioned doomscroll tasks', () => {
    const registry = new PluginRegistry([plugin]);
    const value = registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'doomscroll', taskVersion: 1,
            payload: { durationMinutes: 5, personality: 'casual', likeEnabled: true, saveEnabled: false },
        },
        timing: { kind: 'daily', localTime: '09:00', timezone: 'Asia/Kolkata' },
    });
    assert.equal(value.task.payload.durationMinutes, 5);
});

test('recurring public posts require confirmation', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'post', taskVersion: 1,
            payload: {
                media: [{ assetId: 'asset-1', name: 'video.mp4', mimeType: 'video/mp4' }],
                destination: 'publish', account: '@internal',
            },
        },
        timing: { kind: 'weekly', localTime: '10:00', timezone: 'Asia/Kolkata', weekdays: [1] },
    }), /explicit confirmation/);
});

test('Photo Mode accepts an ordered Assayist deck without changing post@1', () => {
    const registry = new PluginRegistry([plugin]);
    const media = Array.from({ length: 6 }, (_, index) => ({
        assetId: `slide-${index + 1}`,
        name: `${String(index + 1).padStart(2, '0')}.jpg`,
        mimeType: 'image/jpeg',
    }));
    const value = registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id,
            taskType: 'photo-post',
            taskVersion: 1,
            payload: {
                media,
                destination: 'draft',
                account: '@assayist',
                caption: 'Exact Assayist caption',
            },
        },
        timing: { kind: 'now' },
    });
    assert.equal(value.task.taskType, 'photo-post');
    assert.equal((value.task.payload.media as unknown[]).length, 6);
});

test('Photo Mode is image-only and capped at TikTok current 35-photo limit', () => {
    const registry = new PluginRegistry([plugin]);
    const validate = (media: Array<{ assetId: string; name: string; mimeType: string }>) => registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id,
            taskType: 'photo-post',
            taskVersion: 1,
            payload: { media, destination: 'draft', account: '@assayist' },
        },
        timing: { kind: 'now' },
    });
    assert.throws(() => validate([{ assetId: 'v', name: 'clip.mp4', mimeType: 'video/mp4' }]), /images/i);
    assert.throws(() => validate(Array.from({ length: 36 }, (_, index) => ({
        assetId: `slide-${index}`,
        name: `${index}.jpg`,
        mimeType: 'image/jpeg',
    }))), /35/);
});

test('Photo Mode executes only against trusted stored image metadata', async () => {
    const task = plugin.tasks.find(({ type }) => type === 'photo-post');
    assert.ok(task);
    const payload = task.validate({
        media: [{ assetId: 'slide-1', name: '01.jpg', mimeType: 'image/jpeg' }],
        destination: 'draft',
        account: '@assayist',
    }, { timingKind: 'now', devicePluginData: {} });
    let ranProcess = false;
    await assert.rejects(() => task.execute({
        executionId: 'exec-1',
        attempt: 1,
        workspaceDirectory: '/tmp',
        device: { udid: 'device-12345678', name: 'iPhone' },
        devicePluginData: {},
        automation: {
            activateApp: async () => {}, terminateApp: async () => {}, pause: async () => {},
            screenshot: async () => Buffer.alloc(0), tap: async () => {}, swipe: async () => {},
        },
        assets: [{ id: 'slide-1', path: '/tmp/video.mp4', name: 'video.mp4', mimeType: 'video/mp4', size: 100, sha256: 'abc' }],
        signal: new AbortController().signal,
        log: async () => {},
        runProcess: async () => { ranProcess = true; return { exitCode: 0, stopped: false }; },
        claimPipelineItem: async () => null,
        completePipelineItem: async () => {},
        failPipelineItem: async () => {},
    }, payload), /stored Photo Mode asset .* is not an image/i);
    assert.equal(ranProcess, false);
});

test('Photo Mode never turns one approval into a recurring public repost', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id,
            taskType: 'photo-post',
            taskVersion: 1,
            payload: {
                media: [{ assetId: 'slide-1', name: '01.jpg', mimeType: 'image/jpeg' }],
                destination: 'publish',
                account: '@assayist',
                publishConfirmed: true,
            },
        },
        timing: { kind: 'daily', localTime: '12:00', timezone: 'America/New_York' },
    }), /one-shot/i);
});

test('Photo Mode requires explicit approval for every public publish', () => {
    const registry = new PluginRegistry([plugin]);
    const input = {
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id,
            taskType: 'photo-post',
            taskVersion: 1,
            payload: {
                media: [{ assetId: 'slide-1', name: '01.jpg', mimeType: 'image/jpeg' }],
                destination: 'publish',
                account: '@assayist',
            },
        },
        timing: { kind: 'now' as const },
    };
    assert.throws(() => registry.validate(input), /explicit approval/i);
    const approved = registry.validate({
        ...input,
        task: {
            ...input.task,
            payload: { ...input.task.payload, publishConfirmed: true },
        },
    });
    assert.equal(approved.task.payload.publishConfirmed, true);
});
