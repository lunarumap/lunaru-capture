# TEST 0.17 — video compatibility and deliberate storage cleanup

Baseline `accce583` (0.16). Reticle geometry and capture grid unchanged. Only isolated `abc/` app and its tests/docs changed. Same IndexedDB schema and stable public `/abc/` address; no automatic deletion, image reduction or video transcoding.

## Evidence and limits

User confirmed good photo targeting on physical iPhone in 0.16. Supplied Android screenshot explicitly reports another active tab below a misleading storage-failure heading. The heading now distinguishes the tab lock and offers reload after the other tab closes. The actual iPhone video error was not supplied in these screenshots; do not claim its hardware-specific cause is proven.

0.16 rejected decodable videos if frame counters were unavailable. 0.17 keeps a visible probe, offers a direct playback gesture on NotAllowedError, uses a frame-callback fallback, and reports unknown FPS honestly if it cannot measure. Low measured FPS still triggers smaller-mode testing. A playable probe is not a guarantee of sustained physical-phone recording performance.

## Tests executed

`tests/capture-abc.mjs`: PASS, Chromium 153.0.8010.0, simulated rear 640×480 and real MediaRecorder. Existing full A/B/C, ZIP, reload, quota, sensor, orientation and recording-recovery tests passed.

Added and passed:

- Playable real probe with all frame counters disabled returns null measured FPS plus warning, not an encoder error.
- Simulated NotAllowedError recovers through the visible direct-play button, then real video decoding completes.
- User cancellation leaves the selected project intact.
- Confirmed deletion removes that project's metadata, photo blobs and video chunks; counts of every other project's records are unchanged.
- Existing second-tab exclusion remains active.

Deletion is one transaction across projects/files/chunks, keyed by project ID, and includes superseded photo blobs. Home byte totals scan Blob sizes including such retained originals. Browser-managed disk reclamation timing is not guaranteed. ZIP downloads and Drive files are unaffected.

## Reproduce and handoff

Set CHROMIUM_PATH, PLAYWRIGHT_MODULE and FFLATE_MODULE as described in abc/README.md, then run `node tests/capture-abc.mjs`. `node tests/live-smoke.mjs` verifies deployed exact assets and HTTPS recording/reload/playback with a simulated camera.

No physical iPhone or Redmi test of 0.17 was performed here. Open the unchanged public address, verify TEST 0.17, record 10 seconds and play it back before a full pass. If a playback-permission button appears, tap it. Do not clear site data to update. Delete only downloaded, verified or unwanted datasets through their individual confirmation.
