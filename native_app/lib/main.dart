import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:motion_core/motion_core.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const LunaruApp());
}

class LunaruApp extends StatelessWidget {
  const LunaruApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'LUNARU Capture',
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF05090D),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF49B8FF),
          secondary: Color(0xFF59E39A),
          surface: Color(0xFF0F1821),
        ),
        useMaterial3: true,
      ),
      home: const CaptureHome(),
    );
  }
}

class TargetPose {
  final double yawOffsetDeg;
  final double pitchOffsetDeg;
  final String label;

  const TargetPose(this.yawOffsetDeg, this.pitchOffsetDeg, this.label);
}

List<TargetPose> buildTargets() {
  final result = <TargetPose>[];
  for (var i = 0; i < 12; i++) {
    result.add(TargetPose(i * 30.0, 0, 'Горизонт ${i + 1}/12'));
  }
  for (var i = 0; i < 8; i++) {
    result.add(TargetPose(i * 45.0, 35, 'Верх ${i + 1}/8'));
  }
  for (var i = 0; i < 8; i++) {
    result.add(TargetPose(i * 45.0, -35, 'Низ ${i + 1}/8'));
  }
  result.addAll(const [
    TargetPose(0, 75, 'Зенит 1/2'),
    TargetPose(180, 75, 'Зенит 2/2'),
    TargetPose(0, -75, 'Надир 1/2'),
    TargetPose(180, -75, 'Надир 2/2'),
  ]);
  return result;
}

class CaptureHome extends StatefulWidget {
  const CaptureHome({super.key});

  @override
  State<CaptureHome> createState() => _CaptureHomeState();
}

class _CaptureHomeState extends State<CaptureHome>
    with WidgetsBindingObserver {
  final _objectController = TextEditingController(text: 'Проверка');
  final _stationController = TextEditingController(text: 'Станция 01');
  final _targets = buildTargets();

  CameraController? _camera;
  StreamSubscription<MotionData>? _motionSubscription;
  MotionData? _motion;

  bool _starting = false;
  bool _capturing = false;
  bool _captureMode = false;
  bool _motionAvailable = false;
  bool _targetLocked = false;

  int _current = 0;
  double? _baseYaw;
  double? _basePitch;
  double? _lastYaw;
  double? _lastPitch;
  double? _lastMotionTime;
  double _angularSpeedDeg = 999;
  DateTime? _lockStarted;
  DateTime _cooldownUntil = DateTime.fromMillisecondsSinceEpoch(0);

  String _status = 'Готово';
  String? _sessionPath;
  final List<Map<String, dynamic>> _frames = [];

  static const _holdDuration = Duration(milliseconds: 650);
  static const _postShotCooldown = Duration(milliseconds: 450);
  static const _yawTolerance = 14.0;
  static const _pitchTolerance = 11.0;
  static const _stableAngularSpeed = 11.0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _startMotion();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _motionSubscription?.cancel();
    _camera?.dispose();
    _objectController.dispose();
    _stationController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_captureMode) return;
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.paused) {
      _camera?.dispose();
      _camera = null;
    } else if (state == AppLifecycleState.resumed) {
      _openCamera();
    }
  }

  Future<void> _startMotion() async {
    try {
      final available = await MotionCore.isAvailable();
      if (!mounted) return;
      setState(() => _motionAvailable = available);
      if (!available) {
        setState(() => _status = 'Датчики ориентации недоступны');
        return;
      }
      _motionSubscription = MotionCore.motionStream.listen(
        _onMotion,
        onError: (Object error) {
          if (mounted) setState(() => _status = 'Ошибка датчиков: $error');
        },
      );
    } catch (e) {
      if (mounted) setState(() => _status = 'Ошибка датчиков: $e');
    }
  }

  Future<void> _openCamera() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isEmpty) throw Exception('Камеры не найдены');
      final rear = cameras.where((c) => c.lensDirection == CameraLensDirection.back);
      final selected = rear.isNotEmpty ? rear.first : cameras.first;

      final old = _camera;
      final controller = CameraController(
        selected,
        ResolutionPreset.max,
        enableAudio: false,
      );
      await controller.initialize();
      try {
        await controller.setFocusMode(FocusMode.auto);
      } catch (_) {}
      try {
        await controller.setExposureMode(ExposureMode.auto);
      } catch (_) {}
      await old?.dispose();
      if (!mounted) {
        await controller.dispose();
        return;
      }
      setState(() {
        _camera = controller;
        _status = 'Камера готова · MAX';
      });
    } catch (e) {
      if (mounted) setState(() => _status = 'Камера не открылась: $e');
    }
  }

  Future<void> _startCapture() async {
    if (_starting) return;
    setState(() {
      _starting = true;
      _status = 'Запускаю камеру…';
    });
    await _openCamera();
    if (_camera == null || !_camera!.value.isInitialized) {
      if (mounted) setState(() => _starting = false);
      return;
    }

    final docs = await getApplicationDocumentsDirectory();
    final objectName = _safeName(
      _objectController.text.trim().isEmpty ? 'Объект' : _objectController.text.trim(),
    );
    final stationName = _safeName(
      _stationController.text.trim().isEmpty
          ? 'Station_01'
          : _stationController.text.trim(),
    );
    final dir = Directory(p.join(docs.path, 'LUNARU', objectName, stationName));
    await dir.create(recursive: true);

    if (!mounted) return;
    setState(() {
      _sessionPath = dir.path;
      _frames.clear();
      _current = 0;
      _baseYaw = null;
      _basePitch = null;
      _captureMode = true;
      _starting = false;
      _status = 'Наведите на первую цель';
    });
  }

  String _safeName(String value) {
    return value
        .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')
        .replaceAll(RegExp(r'\s+'), '_');
  }

  double _deg(double radians) => radians * 180 / math.pi;

  double _norm(double value) {
    var x = value % 360;
    if (x < 0) x += 360;
    return x;
  }

  double _angleDiff(double a, double b) {
    var d = _norm(a) - _norm(b);
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  void _onMotion(MotionData data) {
    _motion = data;
    if (!_captureMode || _current >= _targets.length) {
      if (mounted) setState(() {});
      return;
    }

    final yaw = _norm(_deg(data.yaw));
    final pitch = _deg(data.pitch);
    final t = data.timestamp;

    if (_lastYaw != null && _lastPitch != null && _lastMotionTime != null) {
      final dt = t - _lastMotionTime!;
      if (dt > 0.002) {
        final dy = _angleDiff(yaw, _lastYaw!).abs();
        final dp = (pitch - _lastPitch!).abs();
        _angularSpeedDeg = math.sqrt(dy * dy + dp * dp) / dt;
      }
    }
    _lastYaw = yaw;
    _lastPitch = pitch;
    _lastMotionTime = t;

    _baseYaw ??= yaw;
    _basePitch ??= pitch;

    final target = _targets[_current];
    final wantedYaw = _norm(_baseYaw! + target.yawOffsetDeg);
    final wantedPitch = _basePitch! + target.pitchOffsetDeg;
    final yawError = _angleDiff(yaw, wantedYaw);
    final pitchError = pitch - wantedPitch;
    final inside = yawError.abs() <= _yawTolerance &&
        pitchError.abs() <= _pitchTolerance;
    final stable = _angularSpeedDeg <= _stableAngularSpeed;

    final now = DateTime.now();
    if (inside && stable && now.isAfter(_cooldownUntil) && !_capturing) {
      _lockStarted ??= now;
      _targetLocked = true;
      if (now.difference(_lockStarted!) >= _holdDuration) {
        _takePicture(auto: true);
      }
    } else {
      _lockStarted = null;
      _targetLocked = false;
    }

    if (mounted) setState(() {});
  }

  Future<void> _takePicture({required bool auto}) async {
    if (_capturing || _current >= _targets.length) return;
    final camera = _camera;
    if (camera == null || !camera.value.isInitialized) return;

    setState(() {
      _capturing = true;
      _targetLocked = true;
      _status = auto ? 'Фиксирую фото…' : 'Снимаю вручную…';
    });

    final frameNumber = _current + 1;
    final target = _targets[_current];
    try {
      final xfile = await camera.takePicture();
      final source = File(xfile.path);
      final dest = File(p.join(
        _sessionPath!,
        'frame_${frameNumber.toString().padLeft(2, '0')}.jpg',
      ));
      if (await dest.exists()) await dest.delete();
      await source.copy(dest.path);
      final bytes = await dest.length();
      final dims = await _readJpegDimensions(dest);

      final yaw = _motion == null ? null : _norm(_deg(_motion!.yaw));
      final pitch = _motion == null ? null : _deg(_motion!.pitch);
      final meta = <String, dynamic>{
        'frame': frameNumber,
        'label': target.label,
        'file': p.basename(dest.path),
        'bytes': bytes,
        'width': dims.$1,
        'height': dims.$2,
        'targetYawOffsetDeg': target.yawOffsetDeg,
        'targetPitchOffsetDeg': target.pitchOffsetDeg,
        'actualYawDeg': yaw,
        'actualPitchDeg': pitch,
        'auto': auto,
        'capturedAt': DateTime.now().toIso8601String(),
      };
      _frames.add(meta);
      await _writeManifest();

      if (!mounted) return;
      setState(() {
        _current++;
        _capturing = false;
        _targetLocked = false;
        _lockStarted = null;
        _cooldownUntil = DateTime.now().add(_postShotCooldown);
        if (_current >= _targets.length) {
          _status = 'Станция готова · ${_frames.length}/32';
        } else {
          final mp = dims.$1 != null && dims.$2 != null
              ? ((dims.$1! * dims.$2!) / 1000000).toStringAsFixed(1)
              : '?';
          _status =
              'Кадр $frameNumber · ${dims.$1 ?? '?'}×${dims.$2 ?? '?'} · $mp Мп · ${(bytes / 1024 / 1024).toStringAsFixed(2)} МБ';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _capturing = false;
        _targetLocked = false;
        _lockStarted = null;
        _cooldownUntil = DateTime.now().add(const Duration(milliseconds: 700));
        _status = 'Ошибка фото: $e';
      });
    }
  }

  Future<(int?, int?)> _readJpegDimensions(File file) async {
    try {
      final raf = await file.open();
      final length = math.min(await raf.length(), 262144);
      final data = await raf.read(length);
      await raf.close();
      if (data.length < 4 || data[0] != 0xFF || data[1] != 0xD8) {
        return (null, null);
      }
      var i = 2;
      while (i + 9 < data.length) {
        if (data[i] != 0xFF) {
          i++;
          continue;
        }
        final marker = data[i + 1];
        i += 2;
        if (marker == 0xD8 || marker == 0xD9) continue;
        if (i + 1 >= data.length) break;
        final segmentLength = (data[i] << 8) | data[i + 1];
        if (segmentLength < 2 || i + segmentLength > data.length) break;
        final isSof = marker == 0xC0 ||
            marker == 0xC1 ||
            marker == 0xC2 ||
            marker == 0xC3 ||
            marker == 0xC5 ||
            marker == 0xC6 ||
            marker == 0xC7 ||
            marker == 0xC9 ||
            marker == 0xCA ||
            marker == 0xCB ||
            marker == 0xCD ||
            marker == 0xCE ||
            marker == 0xCF;
        if (isSof && segmentLength >= 7) {
          final height = (data[i + 3] << 8) | data[i + 4];
          final width = (data[i + 5] << 8) | data[i + 6];
          return (width, height);
        }
        i += segmentLength;
      }
    } catch (_) {}
    return (null, null);
  }

  Future<void> _writeManifest() async {
    if (_sessionPath == null) return;
    final manifest = {
      'schema': 'lunaru-capture-native-station-v1',
      'appVersion': '0.1.0',
      'objectName': _objectController.text.trim(),
      'stationName': _stationController.text.trim(),
      'expectedFrames': _targets.length,
      'capturedFrames': _frames.length,
      'complete': _frames.length == _targets.length,
      'createdAt': DateTime.now().toIso8601String(),
      'frames': _frames,
    };
    final file = File(p.join(_sessionPath!, 'manifest.json'));
    await file.writeAsString(const JsonEncoder.withIndent('  ').convert(manifest));
  }

  Future<void> _retake() async {
    if (_capturing || _current <= 0 || _sessionPath == null) return;
    final frameNumber = _current;
    final file = File(p.join(
      _sessionPath!,
      'frame_${frameNumber.toString().padLeft(2, '0')}.jpg',
    ));
    if (await file.exists()) await file.delete();
    if (_frames.isNotEmpty) _frames.removeLast();
    await _writeManifest();
    if (!mounted) return;
    setState(() {
      _current--;
      _lockStarted = null;
      _targetLocked = false;
      _status = 'Переснятие кадра ${_current + 1}';
    });
  }

  Future<void> _finishStation() async {
    await _writeManifest();
    if (!mounted) return;
    final count = _frames.length;
    final path = _sessionPath;
    setState(() => _captureMode = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Станция сохранена: $count кадров\n$path'),
        duration: const Duration(seconds: 8),
      ),
    );
  }

  Widget _setupScreen() {
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('LUNARU Capture'),
            Text(
              'Нативная съёмка 360° · v0.1',
              style: TextStyle(fontSize: 11, color: Colors.white60),
            ),
          ],
        ),
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(18),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Text(
                      'Новая станция',
                      style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _motionAvailable
                          ? 'Датчики ориентации: готовы'
                          : 'Датчики ориентации: проверка / недоступны',
                      style: const TextStyle(color: Colors.white60),
                    ),
                    const SizedBox(height: 18),
                    TextField(
                      controller: _objectController,
                      decoration: const InputDecoration(
                        labelText: 'Объект',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _stationController,
                      decoration: const InputDecoration(
                        labelText: 'Станция',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 18),
                    FilledButton(
                      onPressed: _starting ? null : _startCapture,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(_starting ? 'ЗАПУСК…' : 'НАЧАТЬ СЪЁМКУ'),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(_status, textAlign: TextAlign.center),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _captureScreen() {
    final camera = _camera;
    final done = _current >= _targets.length;
    final target = done ? null : _targets[_current];
    final yaw = _motion == null ? null : _norm(_deg(_motion!.yaw));
    final pitch = _motion == null ? null : _deg(_motion!.pitch);

    double? yawError;
    double? pitchError;
    if (!done && yaw != null && pitch != null && _baseYaw != null && _basePitch != null) {
      yawError = _angleDiff(yaw, _norm(_baseYaw! + target!.yawOffsetDeg));
      pitchError = pitch - (_basePitch! + target.pitchOffsetDeg);
    }

    String arrow = '';
    if (!done && !_targetLocked && yawError != null && pitchError != null) {
      if (pitchError.abs() > _pitchTolerance) {
        arrow = pitchError < 0 ? '↑' : '↓';
      } else if (yawError.abs() > _yawTolerance) {
        arrow = yawError < 0 ? '→' : '←';
      }
    } else if (_targetLocked) {
      arrow = '✓';
    }

    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: [
          const ColoredBox(color: Colors.black),
          if (camera != null && camera.value.isInitialized)
            Center(
              child: AspectRatio(
                aspectRatio: camera.value.aspectRatio,
                child: CameraPreview(camera),
              ),
            )
          else
            const Center(child: CircularProgressIndicator()),
          SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    children: [
                      Expanded(child: _pill(_objectController.text)),
                      const SizedBox(width: 8),
                      _pill('${_current}/${_targets.length}'),
                    ],
                  ),
                ),
                const Spacer(),
                if (!done)
                  Stack(
                    alignment: Alignment.center,
                    children: [
                      AnimatedContainer(
                        duration: const Duration(milliseconds: 120),
                        width: 148,
                        height: 148,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: _targetLocked
                                ? const Color(0xFF59E39A)
                                : Colors.white,
                            width: 4,
                          ),
                          boxShadow: _targetLocked
                              ? [
                                  BoxShadow(
                                    color: const Color(0xFF59E39A).withOpacity(.25),
                                    blurRadius: 22,
                                    spreadRadius: 8,
                                  )
                                ]
                              : null,
                        ),
                      ),
                      Text(
                        arrow,
                        style: const TextStyle(
                          fontSize: 58,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ],
                  )
                else
                  const Icon(Icons.check_circle, size: 120, color: Color(0xFF59E39A)),
                const Spacer(),
                Container(
                  margin: const EdgeInsets.all(12),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: const Color(0xDD071018),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: const Color(0xFF33516A)),
                  ),
                  child: Column(
                    children: [
                      Text(
                        done ? 'Станция готова' : target!.label,
                        style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        _capturing
                            ? 'Сохраняю полноразмерный JPEG…'
                            : done
                                ? '${_frames.length} кадров сохранено'
                                : 'Скорость движения: ${_angularSpeedDeg.toStringAsFixed(1)}°/с',
                        style: const TextStyle(color: Colors.white70),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _status,
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 12, color: Colors.white70),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
          child: Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _capturing ? null : _retake,
                  child: const Text('Переснять'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: FilledButton(
                  onPressed: done || _capturing ? null : () => _takePicture(auto: false),
                  child: const Text('Снять'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton(
                  onPressed: _capturing ? null : _finishStation,
                  child: const Text('Завершить'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _pill(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: const Color(0xDD071018),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFF33516A)),
      ),
      child: Text(text, overflow: TextOverflow.ellipsis),
    );
  }

  @override
  Widget build(BuildContext context) {
    return _captureMode ? _captureScreen() : _setupScreen();
  }
}
