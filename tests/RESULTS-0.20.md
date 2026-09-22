# TEST 0.20 — field failures and recovery

Field material supplied by the user and inspected on 2026-09-22. Originals remain private; no user photographs or videos are committed to this public repository.

## Observed TEST 0.19 results

| Phone | A | B | C |
| --- | --- | --- | --- |
| iPhone | 13 JPEGs, 2160×3840, all entirely black | 6 JPEGs, 2160×3840, all entirely black | H.264 MP4, 66.53 s, 1910 decoded frames, approximately 28.71 fps |
| Redmi 9 | 32 nonblack ImageCapture JPEGs, 2160×3840 | 40 nonblack ImageCapture JPEGs, 2160×3840 | VP8 WebM, 1512×1080, 119.62 s, 1441 decoded frames, approximately 12.05 fps |
| Redmi A3X | No A archive in the supplied folder; only the user's report is available | 40 nonblack video-frame JPEGs, 2160×3264 | VP8 WebM, 1280×720, 151.17 s, 2500 decoded frames, approximately 16.54 fps |

iPhone MP4 stores 3840×2160 with orientation metadata; the capture manifest/player presents 2160×3840. Frame counts come from full ffprobe decoding. Approximate whole-recording fps is frame count / packet timestamp span; it is not the requested camera fps or a guarantee of stable cadence. Representative decoded video frames and A/B photo samples were visually inspected. Complete file counts do not establish panorama overlap, coverage or stitchability.

All 19 iPhone JPEGs have full-resolution RGB extrema `(0,0)` in every channel. The screenshots show a black preview while the counter advances. Confirmed software defect: the old code checked image dimensions but accepted an unusable camera frame. The exact device/browser trigger for losing the camera is not proven by these files. No telemetry in 0.19 records the exception that initially interrupted A3X A/B. Its subsequent B source is `video-frame`; the existing native-photo failure branch deliberately left capture for a confirmation screen, matching the reported behavior. That branch is reproduced in tests but is not claimed to prove the original hardware exception.

Both Redmi share screenshots report `Failed to execute 'share' on 'Navigator': Permission denied.` A successful canShare check did not guarantee the actual transfer. The exact browser rejection policy is unknown. This was not an upload failure returned by the Google Drive API: LUNARU has no configured direct Drive OAuth integration.

## Changes

- Validate camera live/enabled/muted state, a fresh frame and a small pixel sample before capture; validate the decoded photo too. Reject black frames without changing counters. Release the large canvas backing store after JPEG encoding. Original files are not resized.
- Camera/native-photo failures keep the same capture screen, frame index, object ID and saved sources. A recovery action checks the image, reopens the pinned rear device/zoom when necessary, and repeats the pending frame. Switching from ImageCapture to a video frame requires an explicit choice with actual dimensions. A storage commit failure still preserves previous files and exits safely to the datasets.
- Editable project and station names during photo/video capture. Editing pauses guidance and, when recording, pauses video. Closing resumes the same recording. Rename is queued with media writes, invalidates cached exports, and preserves source IDs. Exported metadata uses the new names.
- Distinct finish/next and save/resume-later buttons. C shows continuous video, recording/paused state and timer; it no longer calls guidance steps photos. A/B retain the 32/40 grids and explicitly label both pole exposures 1/2 and 2/2.
- B/C can calibrate from their first upper target. B/C use about 160 ms circular yaw/pitch smoothing; A retains 85 ms and its existing thresholds. Raw angles and the rear optical-axis calculation are preserved. Smoothing does not prove or repair sensor accuracy. At a pole, the second-frame prompt requests a roughly 90° turn but that turn is not measured or guaranteed.
- A denied ZIP share leaves the exact prepared File downloadable without rebuilding. No false confirmation of a Drive upload. Bounded diagnostic events and browser identification are included in capture.json for subsequent failures.
- IndexedDB name/schema, existing originals, base-013.js and other modules are unchanged. Cleanup remains explicit, confirmed, and local to this browser's A/B/C data.

The camera checks follow [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/): a muted/disabled video source can deliver black frames. [Image Capture](https://www.w3.org/TR/image-capture/) defines asynchronous photo errors; availability does not guarantee every takePhoto succeeds.

## Verification

The full `tests/capture-abc.mjs` suite passed all 25 checks with Chromium 153.0.8010.0, a simulated rear camera and real MediaRecorder: full A/B, retake, pause/resume, reload/interruption recovery, export byte preservation and decoding, quota and encoder errors, sensor geometry, layout, tab protection, individual/bulk cleanup, and share activation/cancellation.

`tests/field-020.mjs` passed after the final recovery and video-caption changes: a live camera producing black pixels cannot add a photo; a track muted during JPEG encoding cannot add one; recovery retains earlier file IDs; large canvas memory is released; rename during photo/video survives reload; denied share downloads precisely the same ZIP; B/C accept their initial upper direction; C continues recording and saves a file. Test-only mocks simulate failures; they are not physical iPhone/Redmi verification.

Run with Node, Playwright, fflate and Chromium:

```sh
CHROMIUM_PATH=/path/to/chromium \
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
FFLATE_MODULE=/path/to/node_modules/fflate node tests/capture-abc.mjs

CHROMIUM_PATH=/path/to/chromium \
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
FFLATE_MODULE=/path/to/node_modules/fflate node tests/field-020.mjs
```

Public deployment verified on 2026-09-22: release commit `f1e186d3f936a0610540b6396f8b6dfd340c258b`, tree `641960589680efb41139322e043700723acf1eea`, GitHub Pages workflow `35716522782` succeeded. `tests/live-smoke.mjs` passed: exact released HTML/JS/CSS/support assets, real MediaRecorder with simulated camera, reload and saved playback over the stable HTTPS URL. An independent request to https://lunarumap.github.io/lunaru-capture/abc/ without query parameters returned HTTP 200 and TEST 0.20. Physical phones were not available to this automated check.

The existing shared links document and Capture rows in the LUNARU journal were updated in place to TEST 0.20 and read back. Both preserve the same public Capture URL; the Sima-Land tour link remains unchanged. No site-data clearing is required to update the app.

Next physical check is small: on iPhone, save three real A photos and three B photos, reopen and inspect the exported JPEGs; on A3X, verify any recovery message keeps the same frame and the explicit fallback continues. No need to repeat full stations before these checks succeed. Direct Drive upload remains unconfigured; physical behavior and sensor feel require phone tests.
