import 'dart:math' as math;
import 'package:flutter_test/flutter_test.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:lunaru_capture/camera_pose.dart';
import 'package:lunaru_capture/main.dart';

void main() {
  test('upright rear camera points at horizon, not at 90 degrees', () {
    final pose = cameraPose(Quaternion.axisAngle(Vector3(1, 0, 0), math.pi / 2));
    expect(pose.pitch, closeTo(0, 0.001));
    expect(pose.yaw, closeTo(0, 0.001));
  });
  test('upper and lower rings use camera elevation', () {
    for (final pitch in [-75.0, -35.0, 35.0, 75.0]) {
      final pose = cameraPose(Quaternion.axisAngle(Vector3(1, 0, 0), (90 + pitch) * math.pi / 180));
      expect(pose.pitch, closeTo(pitch, 0.001));
    }
  });
  test('clockwise turn increases heading', () {
    final q = Quaternion.axisAngle(Vector3(0, 0, 1), -math.pi / 6) *
        Quaternion.axisAngle(Vector3(1, 0, 0), math.pi / 2);
    expect(cameraPose(q).yaw, closeTo(30, 0.001));
  });
  test('target plan retains 32 frames', () {
    expect(buildTargets().length, 32);
  });
}
