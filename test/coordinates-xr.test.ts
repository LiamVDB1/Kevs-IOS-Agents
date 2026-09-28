import assert from 'node:assert/strict';
import test from 'node:test';

import { coordinatesForProfile, profileForProductType } from '../src/devices/coordinates.js';

test('iPhone XR resolves to its calibrated profile', () => {
    assert.equal(profileForProductType('iPhone11,8'), 'iphoneXR');
    const xr = coordinatesForProfile('iphoneXR');
    assert.deepEqual(xr.screenSize, { width: 414, height: 896 });
    // Drafts and Post must never share a tap target.
    assert.notDeepEqual(xr.tiktok.draft, xr.tiktok.finish);
    // The keyboard-dismiss tap must stay clear of the publish-form "+" tile (131–238 × 100–207).
    const dismiss = xr.tiktok.keyboardDismiss!;
    assert.ok(dismiss.x > 238 || dismiss.y > 207);
});
