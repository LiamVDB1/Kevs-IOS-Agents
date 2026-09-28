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

## How the picker is driven (iPhone XR, TikTok 2026-09)

- Photo mode is confirmed by OCR of the camera's mode row: current TikTok builds label the mode carousel inconsistently in the accessibility tree. The flow never continues in an unconfirmed mode.
- Upload is opened by its accessibility id `recordPageUploadButton`.
- "Select multiple" stays on; images are selected through each thumbnail's corner circle (a plain tap opens a preview).
- The imported slides are the newest cells of the Recents grid, in import order. The flow records their positions before the first pick; after that it only tracks the grid's vertical shift (the selection tray pushes the grid up a row and TikTok renumbers its accessibility cells). A 48 px grayscale comparison of each slide against its expected cell must confirm the mapping, or the flow aborts.
- Picker Next, editor Next and the publish form's Post share one screen position. Every Next tap is preceded by a check that the publish form is not open; Drafts and Post are tapped only by accessibility label. On the editor, the Drafts coordinate is "Story 24h", which publishes a Story immediately.
- Photo posts have a separate title field. `title` in the payload fills it; `caption` goes into the description. Focusing the description opens a full-screen editor without Drafts; the flow leaves it through its collapse icon.

## Current verification boundary

Verified on hardware: a 4-slide Assayist deck saved as a TikTok draft on an iPhone XR (iOS 18.7) driven from Linux, including recovery from a tunnel drop mid-run. Public publishing has not been exercised; it requires `publishConfirmed: true`. Decks larger than one screen of picker cells, other iPhone models, and TikTok UI changes remain unverified.
