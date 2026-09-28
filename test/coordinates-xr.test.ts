import assert from 'node:assert/strict';
import test from 'node:test';

import { coordinatesForProfile, profileForProductType } from '../src/devices/coordinates.js';

test('iPhone XR resolves to its calibrated profile', () => {
    assert.equal(profileForProductType('iPhone11,8'), 'iphoneXR');
    const xr = coordinatesForProfile('iphoneXR');
    assert.deepEqual(xr.screenSize, { width: 414, height: 896 });
    // Drafts and Post must never share a tap target.
    assert.notDeepEqual(xr.tiktok.draft, xr.tiktok.finish);
    // The description editor is left through its collapse icon, not a blind dismiss tap.
    assert.ok(xr.tiktok.captionCollapse);
    assert.equal(xr.tiktok.keyboardDismiss, undefined);
});
