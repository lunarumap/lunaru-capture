# TEST 0.18 — ZIP file sharing and cleanup guidance

Baseline: e659018 (0.17). Same public `/abc/` address, IndexedDB schema, originals and reticle. No Google credentials, OAuth flow, remote deletion or automatic local deletion added.

## Behavior

File-capable browsers offer ZIP preparation followed by a distinct direct-click share button. The OS chooses available apps; users select Google Drive and the destination themselves. ZIP support is checked with the actual File. Unsupported browsers keep ordinary download. Share cancellation preserves original media and the prepared file for retry. A resolved share promise is explicitly NOT a confirmed cloud upload and does not mark a download confirmed. One prepared File is retained, invalidated on capture, revision/project change or object deletion, and released after a successful handoff.

ZIP assembly disables conflicting station controls. Home cleanup instructions distinguish local browser originals, downloaded ZIPs and cloud copies. The station exit button now says “К списку объектов / очистка”.

## Validation

Full `tests/capture-abc.mjs` passed in Chromium 153 with simulated rear camera and real MediaRecorder. New native-share mock assertions: no sheet opens during asynchronous preparation; share is called directly in the second click; cancellation keeps 32 original photos; shared ZIP photos match previously exported photo bytes; cloud upload/download confirmation is not fabricated. Existing A/B/C, video, reload, quota, deletion and guidance tests also passed.

Native iPhone/Android share sheets and actual Google Drive upload have not been physically tested here. Availability depends on browser, OS and installed share targets. Reference: https://www.w3.org/TR/web-share/ (share requires transient user activation; canShare validates supported data).

Reproduce using Node/Playwright/fflate and CHROMIUM_PATH as described in abc/README.md. `tests/live-smoke.mjs` verifies exact deployed assets and recording/reload/playback over HTTPS; it does not upload to Drive.
