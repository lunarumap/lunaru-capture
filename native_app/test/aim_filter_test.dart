import 'package:flutter_test/flutter_test.dart';
import 'package:lunaru_capture/aim_filter.dart';

void main() {
  final start = DateTime(2026);
  test('small alternating sensor noise is attenuated', () {
    final filter = AimFilter()..update(0, 0, start);
    for (var i = 1; i <= 100; i++) {
      filter.update(i.isEven ? 3 : -3, i.isEven ? 2 : -2,
          start.add(Duration(milliseconds: i * 20)));
      expect(filter.yaw.abs(), lessThan(1));
      expect(filter.pitch.abs(), lessThan(1));
    }
  });
  test('opposite heading does not bounce left and right at angle wrap', () {
    final filter = AimFilter()..update(179, 0, start);
    for (var i = 1; i <= 20; i++) {
      filter.update(i.isEven ? 179 : -179, 0,
          start.add(Duration(milliseconds: i * 20)));
      expect(filter.yaw, greaterThan(175));
    }
  });
  test('new target and resumed sensor stream discard old smoothing', () {
    final filter = AimFilter()..update(30, 35, start);
    filter.reset();
    filter.update(-30, -35, start.add(const Duration(milliseconds: 20)));
    expect(filter.yaw, -30);
    expect(filter.pitch, -35);
    filter.update(0, 0, start.add(const Duration(seconds: 2)));
    expect(filter.yaw, 0);
    expect(filter.pitch, 0);
  });
  test('steady target settles within one degree in 500ms', () {
    final filter = AimFilter()..update(30, 35, start);
    for (var i = 1; i <= 25; i++) {
      filter.update(0, 0, start.add(Duration(milliseconds: i * 20)));
    }
    expect(filter.yaw.abs(), lessThan(1));
    expect(filter.pitch.abs(), lessThan(1));
  });
}
