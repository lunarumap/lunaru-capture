# LUNARU Capture v0.4 — 18 September 2026

## Device evidence from v0.3
- Redmi A3X: user completed all 32 frames. Small marker jitter remains.
- Redmi 9: completed horizon; upper first target hard to acquire, reported left/right bouncing.
- Screenshot JPEG metadata: 3120×4160 (13 MP), 2.17–2.56 MB. Original JPEGs not received; sharpness unverified.

## Changes
- Display-only 120 ms exponential smoothing with circular heading handling and wrap hysteresis.
- Raw pose/stability still gate capture; both displayed and raw errors must fit 8° entry / 10° hold tolerances. 600 ms hold retained.
- Sensor gaps >250 ms and target transitions reset smoothing/hold state.
- Plain-language up/down and turn instructions; retain successful moving-circle UX.
- Share saved station original JPEGs via system share sheet, including after restart. No image re-encoding. Select Google Drive for quality review.
- Unique session directories avoid overwriting repeated station names.
- Max camera resolution and autofocus/autoexposure retained.

## Verification and remaining work
CI builds Android APK and runs orientation and smoothing tests. Physical-device capture and share-sheet testing still required on BOTH phones. Need original files for quality assessment. Do not claim Redmi9 defect resolved before user test.
Unchanged limitation: the two upward and two downward targets ignore yaw and can repeat the same view; 32-frame completion alone does not prove panorama coverage.

## Test sequence
1. On Redmi9 complete horizon then upper ring; watch transition, overshoot, left/right bouncing and auto shutter.
2. Repeat full station on A3X to check regression.
3. Finish, open Stations / send originals, choose station and Google Drive. Use distinct folders for each phone.
4. Photograph the same detailed stationary scene in LUNARU and stock Camera at default 1×, same position/light. Compare original JPEG dimensions, EXIF exposure/ISO, center and corner sharpness, blur and noise at 100%.
