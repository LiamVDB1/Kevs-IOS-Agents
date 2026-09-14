import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { matchPickerCellsToImages } from '../src/tiktok/post-picker-match.js';

async function solidPng(filePath: string, rgb: { r: number; g: number; b: number }): Promise<void> {
    await sharp({ create: { width: 240, height: 320, channels: 3, background: rgb } }).png().toFile(filePath);
}

async function pickerScreenshot(images: Buffer[]): Promise<Buffer> {
    const cellSize = 120;
    const canvas = sharp({
        create: { width: cellSize * images.length, height: cellSize, channels: 3, background: { r: 0, g: 0, b: 0 } },
    });
    const composites = await Promise.all(images.map(async (image, index) => ({
        input: await sharp(image).resize(cellSize, cellSize, { fit: 'cover' }).png().toBuffer(),
        left: index * cellSize,
        top: 0,
    })));
    return canvas.composite(composites).png().toBuffer();
}

test('Photo Mode image matcher maps manifest order to distinct picker cells', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-photo-match-'));
    try {
        const red = path.join(directory, '01-red.png');
        const green = path.join(directory, '02-green.png');
        const blue = path.join(directory, '03-blue.png');
        await solidPng(red, { r: 230, g: 30, b: 20 });
        await solidPng(green, { r: 20, g: 220, b: 40 });
        await solidPng(blue, { r: 20, g: 50, b: 230 });

        // Picker order is deliberately different from manifest order.
        const screenshot = await pickerScreenshot([
            await sharp(blue).toBuffer(),
            await sharp(red).toBuffer(),
            await sharp(green).toBuffer(),
        ]);
        const cells = [0, 1, 2].map((index) => ({
            index,
            x: index * 120,
            y: 0,
            width: 120,
            height: 120,
        }));

        const matches = await matchPickerCellsToImages(screenshot, 1, cells, [red, green, blue]);
        assert.deepEqual(matches.map(({ cell }) => cell.index), [1, 2, 0]);
        assert.equal(new Set(matches.map(({ cell }) => cell.index)).size, 3);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('Photo Mode image matcher refuses an ambiguous or visibly wrong picker', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'phone-farm-photo-match-'));
    try {
        const red = path.join(directory, 'red.png');
        await solidPng(red, { r: 240, g: 20, b: 20 });
        const screenshot = await pickerScreenshot([
            await sharp({ create: { width: 240, height: 320, channels: 3, background: { r: 20, g: 20, b: 240 } } }).png().toBuffer(),
        ]);
        const cells = [{ index: 0, x: 0, y: 0, width: 120, height: 120 }];
        await assert.rejects(
            () => matchPickerCellsToImages(screenshot, 1, cells, [red]),
            /could not confidently match/i,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
