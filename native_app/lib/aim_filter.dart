import 'dart:math' as math;

/// Display-only smoothing. Capture must still check the raw pose and stability.
class AimFilter {
  double yaw = 0;
  double pitch = 0;
  DateTime? _last;

  void reset() => _last = null;

  void update(double rawYaw, double rawPitch, DateTime now) {
    final last = _last;
    _last = now;
    if (last == null || now.difference(last).inMilliseconds > 250) {
      yaw = rawYaw;
      pitch = rawPitch;
      return;
    }
    final dt = now.difference(last).inMicroseconds / 1000;
    final alpha = 1 - math.exp(-math.max(0, dt) / 120);
    var delta = (rawYaw - yaw + 180) % 360 - 180;
    yaw += alpha * delta;
    // Hysteresis at the opposite heading avoids left/right flips near 180°.
    if (yaw > 190) yaw -= 360;
    if (yaw < -190) yaw += 360;
    pitch += alpha * (rawPitch - pitch);
  }
}
