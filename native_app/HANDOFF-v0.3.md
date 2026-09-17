# LUNARU Capture v0.3 — pending build

User: Mikhail Trenin. Test device: Redmi 9. Installed version: native v0.2.
Reported failures: automatic capture does not trigger in normal shooting posture;
portrait preview and aim overlay are misaligned; button labels wrap.

Repository: https://github.com/lunarumap/lunaru-capture
Source branch before changes: native-flutter-v0.2, commit 1cd9062571e430811ad1defed3d56f51fc51774b.
That commit's v0.2.1 build succeeded (Actions run 35276337397), but only patches camera startup.
Drive folder CAPTURE: https://drive.google.com/drive/folders/1ldYPMKXKgByCVdxO3zPtIdd5dP8Iyz7p
Installed v0.2 ZIP: Drive ID 1btQomj-UWOmO3Tfow7IIh62aaTeDNNfi (contains APK only).

Prepared branch: native-flutter-v0.3. Version: 0.3.0+4.
Changes:
- Calculate rear-camera direction from attitude quaternion (device -Z).
  motion_core pitch is approximately +90 degrees when held upright; it is not camera elevation.
- Portrait orientation, reciprocal preview aspect ratio, center aim inside preview.
- Separate retake/finish button row and full-width manual shutter.
- Hold-progress indicator and signed target errors; completed frame count.
- Stop automatic capture during station finish dialog; save pose at shutter invocation.
- Move camera startup fix into source instead of editing source during CI.
- Add orientation regression tests and CI flutter test step.

Validation: git diff --check passed. Flutter/Dart not installed locally.
Flutter analyze/tests/APK build have NOT run for v0.3. No claim of device validation.
Push was rejected by automatic approval review because explicit permission to publish
modified source to GitHub was required. Do not retry without user approval.
After approval: push branch; wait for CI and fix any analyze/test failures; download
resulting APK; verify version and compare signing certificate with installed v0.2.
Signing cache is branch-scoped, so verify upgrade compatibility before delivery.
Save final APK ZIP to existing Drive CAPTURE folder, verify metadata, provide link.
Do not call a build successful merely because a workflow was triggered.
