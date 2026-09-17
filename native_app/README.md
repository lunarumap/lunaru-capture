# LUNARU Capture — native v0.1

Native mobile prototype for guided 360° capture.

## Purpose

The web prototype proved the capture UX but exposed browser camera limits: high-resolution still capture can stall or blank the live preview. This native Flutter app separates live camera preview from full-resolution photo capture using the platform camera APIs.

## v0.1 scope

- rear camera only;
- native live preview;
- native `takePicture()` full-resolution JPEG capture;
- 32 guided targets: 12 horizon, 8 upper, 8 lower, 2 zenith, 2 nadir;
- fused motion orientation through `motion_core`;
- movement-speed gate + 650 ms hold before automatic capture;
- no second shot until the previous JPEG is fully saved;
- manual capture and retake;
- JPEG width/height read directly from the JPEG header;
- per-frame size, dimensions, target angles and measured angles in `manifest.json`;
- local station storage under the app documents directory.

## Data layout

`LUNARU/<object>/<station>/`

- `frame_01.jpg` ... `frame_32.jpg`
- `manifest.json`

## Next

1. Verify actual camera resolution and capture latency on Redmi 9 and iPhone 11.
2. Tune orientation conventions and target tolerances using real devices.
3. Add station/object ZIP export compatible with LUNARU Studio.
4. Add GPS mode and station preview thumbnail.
5. Add quality gates: blur, exposure and minimum resolution.

The existing GitHub Pages web app remains a test bench and is not the target production architecture.
