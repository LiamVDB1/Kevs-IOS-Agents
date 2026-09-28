import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyExpectedAssignment } from '../src/tiktok/post-picker-match.js';

// Scores measured on a live iPhone XR picker for a 4-slide deck (rows: slides 1–4,
// columns: the newest four cells in reading order).
const LIVE = [
    [205.3, 33.2, 15.4, 4.6],
    [208.1, 32.5, 3.6, 14.7],
    [195.9, 6.2, 34.1, 33.7],
    [2.7, 195.2, 207.0, 204.7],
];

test('the reversed-import positional mapping verifies against live scores', () => {
    assert.equal(verifyExpectedAssignment(LIVE, [3, 2, 1, 0]), undefined);
});

test('a wrong or swapped order is rejected rather than guessed', () => {
    assert.match(verifyExpectedAssignment(LIVE, [0, 1, 2, 3])!, /image 1/);
    assert.match(verifyExpectedAssignment(LIVE, [2, 3, 1, 0])!, /image 1/);
});

test('two near-identical slides cannot be told apart and fail closed', () => {
    assert.ok(verifyExpectedAssignment([[3, 4], [4, 3]], [0, 1]));
});
