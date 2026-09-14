# TikTok Photo Mode

The built-in TikTok plugin exposes a separate, versioned `photo-post@1` task for ordered image carousels. It does not change the older generic `post@1` contract.

## Safety contract

`photo-post@1`:

- accepts 1–35 image assets only;
- verifies the referenced server-side asset is really stored as an image and caps Photo Mode images at 25 MB each;
- preserves the payload order as the intended slide order;
- can save a draft without a publication approval flag;
- requires `publishConfirmed: true` for every public publish;
- allows public publishing only as `now` or one-time schedules—daily/weekly public reposts are rejected;
- has no automatic retry policy after failure, because a retry near the final Post boundary can create duplicates;
- refuses to guess when imported picker thumbnails cannot be matched confidently to the requested images.

The native composer path explicitly selects Photo mode rather than reusing the generic video-oriented path. For multi-image posts it enables Select multiple, verifies each visible imported thumbnail against the corresponding source image, taps those cells in manifest order, and disables TikTok's layout mode.

The task envelope accepts TikTok's current 35-image ceiling, but the selector intentionally refuses to guess when all requested imports cannot be proven from the currently visible picker cells. Cross-viewport scrolling/selection is not claimed as verified yet. The first hardware acceptance target is an Assayist-sized 5–8 slide deck; larger decks must fail cleanly until native traversal is implemented and tested.

## Dashboard

The device page contains a dedicated **Photo Mode** form. Choose the images in final slide order, account, destination, optional TikTok music URL, caption, and timing. Selecting Publish requires the explicit approval checkbox.

The generic **Post media** form remains available for the original `post@1` behavior.

## Task envelope

Example payload shape:

```json
{
  "pluginId": "com.git-agni.tiktok",
  "taskType": "photo-post",
  "taskVersion": 1,
  "payload": {
    "media": [
      { "assetId": "asset-1", "name": "01.jpg", "mimeType": "image/jpeg" },
      { "assetId": "asset-2", "name": "02.jpg", "mimeType": "image/jpeg" }
    ],
    "destination": "draft",
    "account": "@assayist",
    "caption": "Exact publication caption",
    "musicUrl": "https://www.tiktok.com/..."
  }
}
```

For a public publish add:

```json
{ "publishConfirmed": true }
```

This flag is deliberately per-task approval. Public Photo Mode tasks are one-shot; recurring schedules are rejected rather than turning one approval into repeated publication.

## Current verification boundary

The image-order matcher is covered with synthetic picker tests, including shuffled thumbnail order and a negative wrong-image case. Full native Photo Mode behavior still requires a real iPhone running the current TikTok UI; coordinate/accessibility changes in TikTok must be treated as runtime compatibility work rather than silently bypassed.
