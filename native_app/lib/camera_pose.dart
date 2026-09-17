import 'dart:math' as math;
import 'package:vector_math/vector_math_64.dart';

/// Rear camera looks along device -Z, not along the phone's top edge.
/// motion_core attitude rotates device coordinates into a Z-up world.
({double yaw, double pitch}) cameraPose(Quaternion q) {
  final x = -2 * (q.x * q.z + q.w * q.y);
  final y = 2 * (q.w * q.x - q.y * q.z);
  final z = 2 * (q.x * q.x + q.y * q.y) - 1;
  return (
    yaw: (math.atan2(x, y) * 180 / math.pi + 360) % 360,
    pitch: math.atan2(z, math.sqrt(x * x + y * y)) * 180 / math.pi,
  );
}
