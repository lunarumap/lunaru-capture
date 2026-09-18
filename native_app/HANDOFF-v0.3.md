# LUNARU Capture v0.3 — built, pending Redmi 9 test

Version 0.3.0+4; package com.lunaru.lunaru_capture.
Source commit: 6582a48d22a60bd6839985dd3cd9a693de14cf50.
Successful Actions run: 35280774717; artifact 10522193718.
Flutter analysis and all four orientation/target-plan tests passed. Device and visual layout tests have NOT been performed.

Changes: rear-camera -Z quaternion direction instead of device Euler pitch; portrait preview and centered guidance; separated controls; hold progress; capture pause during finish dialog; pose recorded at shutter invocation.

Delivered ZIP: https://drive.google.com/file/d/1NQhUTBpKec8PCOQKYeNaSROV1w3t18E3/view
Drive CAPTURE folder: 1ldYPMKXKgByCVdxO3zPtIdd5dP8Iyz7p.
ZIP SHA256: 00742309e88a7b2a4acffd64385bf24ab51a50303f52708fc56ed525270b2f5f.

IMPORTANT: v0.3 signing certificate SHA256 87af42e85fe91b8df7345e2e7693278058eed9d140d2976a013e59e192be1db4 differs from installed v0.2 certificate c0dc12d8600105d3a8e2ff964c042467e2844ec0ec9eba87189d074405022b5f. Rebuilding on v0.2 branch did not restore the original installed key. In-place update is NOT compatible. Do not instruct deletion before needed photographs are backed up. No user data was deleted. Original v0.2 remains in Drive (1btQomj-UWOmO3Tfow7IIh62aaTeDNNfi).

Next: user device test on Redmi 9; confirm camera preview, horizontal auto shot and subsequent targets. User authorized GitHub publication and builds. Source branches native-flutter-v0.2 and native-flutter-v0.3 contain this implementation; main is still the web prototype.
