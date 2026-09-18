import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'camera_pose.dart';
import 'aim_filter.dart';
import 'package:share_plus/share_plus.dart';
import 'package:motion_core/motion_core.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
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
  final double pitchDeg;
  final String label;
  final bool ignoreYaw;

  const TargetPose(
    this.yawOffsetDeg,
    this.pitchDeg,
    this.label, {
    this.ignoreYaw = false,
  });
}

class PoseSample {
  final DateTime time;
  final double yaw;
  final double pitch;

  const PoseSample(this.time, this.yaw, this.pitch);
}

List<TargetPose> buildTargets() {
  final result = <TargetPose>[];

  // 1) Always begin with a true horizontal ring.
  for (var i = 0; i < 12; i++) {
    result.add(TargetPose(i * 30.0, 0, 'Горизонт ${i + 1}/12'));
  }

  // 2) Upper ring.
  for (var i = 0; i < 8; i++) {
    result.add(TargetPose(i * 45.0, 35, 'Верх ${i + 1}/8'));
  }

  // 3) Lower ring.
  for (var i = 0; i < 8; i++) {
    result.add(TargetPose(i * 45.0, -35, 'Низ ${i + 1}/8'));
  }

  // 4) Zenith / nadir. Yaw is deliberately ignored here.
  result.addAll(const [
    TargetPose(0, 75, 'Камеру вверх 1/2', ignoreYaw: true),
    TargetPose(180, 75, 'Камеру вверх 2/2', ignoreYaw: true),
    TargetPose(0, -75, 'Камеру вниз 1/2', ignoreYaw: true),
    TargetPose(180, -75, 'Камеру вниз 2/2', ignoreYaw: true),
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

  bool _finishing = false;
  bool _starting = false;
  bool _capturing = false;
  bool _captureMode = false;
  bool _motionAvailable = false;
  bool _targetLocked = false;
  bool _insideTarget = false;

  int _current = 0;
  double? _baseYaw;
  final _aimFilter = AimFilter();
  double _displayYaw = 0;
  double _displayPitch = 0;
  double _yawError = 0;
  double _pitchError = 0;
  DateTime? _lockStarted;
  DateTime _cooldownUntil = DateTime.fromMillisecondsSinceEpoch(0);

  String _status = 'Готово';
  String? _sessionPath;
  String? _lastShotSummary;

  final List<Map<String, dynamic>> _frames = [];
  final List<PoseSample> _poseHistory = [];

  // Keep capture bounds below half the 30-degree horizontal target spacing.
  static const _holdDuration = Duration(milliseconds: 600);
  static const _postShotCooldown = Duration(milliseconds: 550);
  static const _stabilityWindow = Duration(milliseconds: 320);
  static const _enterYawTolerance = 8.0;
  static const _enterPitchTolerance = 8.0;
  static const _keepYawTolerance = 10.0;
  static const _keepPitchTolerance = 10.0;
  static const _maxYawJitter = 8.0;
  static const _maxPitchJitter = 6.0;

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
      _lockStarted = null;
      _targetLocked = false;
      _poseHistory.clear();
      _aimFilter.reset();
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
          if (mounted) {
            setState(() => _status = 'Ошибка датчиков: $error');
          }
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

      final rear = cameras.where(
        (c) => c.lensDirection == CameraLensDirection.back,
      );
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
        _status = 'Камера готова';
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
      _objectController.text.trim().isEmpty
          ? 'Объект'
          : _objectController.text.trim(),
    );
    final stationName = _safeName(
      _stationController.text.trim().isEmpty
          ? 'Station_01'
          : _stationController.text.trim(),
    );
    final dir = Directory(p.join(docs.path, 'LUNARU', objectName, '${stationName}_${DateTime.now().microsecondsSinceEpoch}'));
    await dir.create(recursive: true);

    // Yaw is relative to the direction in which the operator starts.
    // Pitch is NOT relative: 0° is always the real horizontal target.
    final currentMotion = _motion;
    final baseYaw = currentMotion == null
        ? null
        : cameraPose(currentMotion.attitude).yaw;

    if (!mounted) return;
    setState(() {
      _sessionPath = dir.path;
      _frames.clear();
      _poseHistory.clear();
      _aimFilter.reset();
      _current = 0;
      _baseYaw = baseYaw;
      _captureMode = true;
      _starting = false;
      _targetLocked = false;
      _insideTarget = false;
      _lastShotSummary = null;
      _lockStarted = null;
      _status = 'Горизонт 1/12 · наведите телефон прямо';
    });
  }

  String _safeName(String value) {
    return value
        .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_')
        .replaceAll(RegExp(r'\s+'), '_');
  }

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
    if (!_captureMode || _finishing || _current >= _targets.length) {
      if (mounted) setState(() {});
      return;
    }

    final pose = cameraPose(data.attitude);
    final yaw = pose.yaw;
    final pitch = pose.pitch;
    _baseYaw ??= yaw;

    final now = DateTime.now();
    if (_poseHistory.isNotEmpty &&
        now.difference(_poseHistory.last.time).inMilliseconds > 250) {
      _poseHistory.clear();
      _lockStarted = null;
      _targetLocked = false;
      _aimFilter.reset();
    }
    _poseHistory.add(PoseSample(now, yaw, pitch));
    final oldest = now.subtract(_stabilityWindow);
    _poseHistory.removeWhere((sample) => sample.time.isBefore(oldest));

    final target = _targets[_current];
    final wantedYaw = _norm(_baseYaw! + target.yawOffsetDeg);
    final wantedPitch = target.pitchDeg;

    _yawError = target.ignoreYaw ? 0 : _angleDiff(yaw, wantedYaw);
    _pitchError = pitch - wantedPitch;
    _aimFilter.update(_yawError, _pitchError, now);
    _displayYaw = _aimFilter.yaw;
    _displayPitch = _aimFilter.pitch;

    final yawTolerance = _targetLocked
        ? _keepYawTolerance
        : _enterYawTolerance;
    final pitchTolerance = _targetLocked
        ? _keepPitchTolerance
        : _enterPitchTolerance;

    final inside = target.ignoreYaw
        ? _pitchError.abs() <= pitchTolerance
        : _yawError.abs() <= yawTolerance &&
            _pitchError.abs() <= pitchTolerance;

    final stable = _isPoseStable(target.ignoreYaw);
    final displayInside = _displayYaw.abs() <= yawTolerance &&
        _displayPitch.abs() <= pitchTolerance;
    final ready = inside && displayInside && stable &&
        _camera != null && _camera!.value.isInitialized && now.isAfter(_cooldownUntil);

    _insideTarget = inside;

    if (ready && !_capturing) {
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

  bool _isPoseStable(bool ignoreYaw) {
    if (_poseHistory.length < 2) return false;

    final duration = _poseHistory.last.time.difference(_poseHistory.first.time);
    if (duration < const Duration(milliseconds: 180)) return false;

    final firstYaw = _poseHistory.first.yaw;
    var maxYawDelta = 0.0;
    var minPitch = _poseHistory.first.pitch;
    var maxPitch = _poseHistory.first.pitch;

    for (final sample in _poseHistory) {
      maxYawDelta = math.max(
        maxYawDelta,
        _angleDiff(sample.yaw, firstYaw).abs(),
      );
      minPitch = math.min(minPitch, sample.pitch);
      maxPitch = math.max(maxPitch, sample.pitch);
    }

    final pitchJitter = maxPitch - minPitch;
    final yawOk = ignoreYaw || maxYawDelta <= _maxYawJitter;
    return yawOk && pitchJitter <= _maxPitchJitter;
  }

  Future<void> _takePicture({required bool auto}) async {
    if (!_captureMode || _finishing || _capturing || _current >= _targets.length) return;
    final camera = _camera;
    if (camera == null || !camera.value.isInitialized) return;
    if (_sessionPath == null) return;

    setState(() {
      _capturing = true;
      _targetLocked = true;
      _status = auto ? 'Фиксирую…' : 'Снимаю вручную…';
    });

    final shotPose = _motion == null ? null : cameraPose(_motion!.attitude);
    final frameNumber = _current + 1;
    final target = _targets[_current];

    try {
      final xfile = await camera.takePicture();
      final source = File(xfile.path);
      final dest = File(
        p.join(
          _sessionPath!,
          'frame_${frameNumber.toString().padLeft(2, '0')}.jpg',
        ),
      );
      if (await dest.exists()) await dest.delete();
      await source.copy(dest.path);

      final bytes = await dest.length();
      final dims = await _readJpegDimensions(dest);
      final actualYaw = shotPose?.yaw;
      final actualPitch = shotPose?.pitch;

      _frames.add({
        'frame': frameNumber,
        'label': target.label,
        'file': p.basename(dest.path),
        'bytes': bytes,
        'width': dims.$1,
        'height': dims.$2,
        'targetYawOffsetDeg': target.yawOffsetDeg,
        'targetPitchDeg': target.pitchDeg,
        'ignoreYaw': target.ignoreYaw,
        'actualYawDeg': actualYaw,
        'actualPitchDeg': actualPitch,
        'auto': auto,
        'capturedAt': DateTime.now().toIso8601String(),
      });

      await _writeManifest();

      if (!mounted) return;
      final mp = dims.$1 != null && dims.$2 != null
          ? ((dims.$1! * dims.$2!) / 1000000).toStringAsFixed(1)
          : '?';
      final summary =
          '${dims.$1 ?? '?'}×${dims.$2 ?? '?'} · $mp Мп · ${(bytes / 1024 / 1024).toStringAsFixed(2)} МБ';

      setState(() {
        _lastShotSummary = summary;
        _current++;
        _aimFilter.reset();
        _capturing = false;
        _targetLocked = false;
        _insideTarget = false;
        _lockStarted = null;
        _poseHistory.clear();
        _cooldownUntil = DateTime.now().add(_postShotCooldown);

        if (_current >= _targets.length) {
          _status = 'Станция готова · ${_frames.length}/32';
        } else {
          _status = '${_targets[_current].label} · $summary';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _capturing = false;
        _targetLocked = false;
        _insideTarget = false;
        _lockStarted = null;
        _poseHistory.clear();
        _cooldownUntil = DateTime.now().add(
          const Duration(milliseconds: 800),
        );
        _status = 'Ошибка фото: $e';
      });
    }
  }

  Future<void> _retakePrevious() async {
    if (_capturing || _finishing || _frames.isEmpty) return;
    _finishing = true;
    try {
      // Keep the old JPEG until a replacement is captured successfully.
      final previous = _frames.removeLast();
      _current = (previous['frame'] as int) - 1;
      _poseHistory.clear();
      _aimFilter.reset();
      _lockStarted = null;
      _targetLocked = false;
      _insideTarget = false;
      _lastShotSummary = null;
      await _writeManifest();
      if (mounted) setState(() => _status = 'Переснять: ${_targets[_current].label}');
    } catch (e) {
      if (mounted) setState(() => _status = 'Ошибка пересъёмки: $e');
    } finally {
      if (mounted) setState(() => _finishing = false);
    }
  }

  Future<void> _finishStation() async {
    if (!_captureMode || _capturing || _finishing) return;
    setState(() {
      _finishing = true;
      _lockStarted = null;
      _targetLocked = false;
    });
    try {
      await _writeManifest();
    } catch (e) {
      if (mounted) setState(() { _finishing = false; _status = "Ошибка сохранения: $e"; });
      return;
    }
    if (!mounted) return;

    final count = _frames.length;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Text('Станция сохранена'),
        content: Text(
          count == 32
              ? 'Снято 32 из 32 кадров. Станция завершена.'
              : 'Снято $count из 32 кадров. Станция сохранена как незавершённая.',
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Готово'),
          ),
        ],
      ),
    );

    await _camera?.dispose();
    if (!mounted) return;
    setState(() {
      _camera = null;
      _captureMode = false;
      _finishing = false;
      _capturing = false;
      _targetLocked = false;
      _insideTarget = false;
      _status = 'Станция сохранена · $count/32';
    });
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
      'appVersion': '0.4.0',
      'objectName': _objectController.text.trim(),
      'stationName': _stationController.text.trim(),
      'expectedFrames': _targets.length,
      'capturedFrames': _frames.length,
      'complete': _frames.length == _targets.length,
      'updatedAt': DateTime.now().toIso8601String(),
      'frames': _frames,
    };
    final file = File(p.join(_sessionPath!, 'manifest.json'));
    await file.writeAsString(
      const JsonEncoder.withIndent('  ').convert(manifest),
      flush: true,
    );
  }

  String _guidanceArrow() {
    if (_current >= _targets.length || _motion == null) return '✓';
    if (_targetLocked) return '●';
    if (_displayPitch.abs() > _enterPitchTolerance) {
      return _displayPitch > 0 ? '↓' : '↑';
    }
    if (_displayYaw.abs() > _enterYawTolerance) {
      return _displayYaw > 0 ? '←' : '→';
    }
    return '•';
  }

  String _directionText() {
    final parts = <String>[];
    if (_displayPitch.abs() > _enterPitchTolerance) {
      parts.add('${_displayPitch > 0 ? "Опустите" : "Поднимите"} камеру на ${_displayPitch.abs().round()}°');
    }
    if (_displayYaw.abs() > _enterYawTolerance) {
      parts.add('${_displayYaw > 0 ? "Влево" : "Вправо"} на ${_displayYaw.abs().round()}°');
    }
    return parts.isEmpty ? 'Удерживайте камеру неподвижно' : parts.join(' · ');
  }

  Future<void> _showSavedStations() async {
    try {
      final docs = await getApplicationDocumentsDirectory();
      final root = Directory(p.join(docs.path, 'LUNARU'));
      final manifests = <File>[];
      if (await root.exists()) {
        await for (final entity in root.list(recursive: true)) {
          if (entity is File && p.basename(entity.path) == 'manifest.json') {
            manifests.add(entity);
          }
        }
      }
      manifests.sort((a, b) => b.path.compareTo(a.path));
      if (!mounted) return;
      await showModalBottomSheet<void>(context: context, builder: (context) {
        return SafeArea(child: manifests.isEmpty
          ? const Padding(padding: EdgeInsets.all(24), child: Text('Сохранённых станций пока нет'))
          : ListView(children: [
              const ListTile(title: Text('Отправить оригиналы'),
                subtitle: Text('Выберите станцию, затем Google Диск. JPEG передаются без изменения.')),
              for (final manifest in manifests) ListTile(
                title: Text(p.basename(manifest.parent.path)),
                subtitle: Text(p.basename(manifest.parent.parent.path)),
                trailing: const Icon(Icons.share),
                onTap: () { Navigator.pop(context); _shareStation(manifest); },
              ),
            ]));
      });
    } catch (e) {
      if (mounted) setState(() => _status = 'Не удалось открыть станции: $e');
    }
  }

  Future<void> _shareStation(File manifest) async {
    try {
      final data = jsonDecode(await manifest.readAsString()) as Map<String, dynamic>;
      final frames = data['frames'] as List<dynamic>;
      final files = <XFile>[];
      for (final frame in frames) {
        final file = File(p.join(manifest.parent.path, p.basename(frame['file'] as String)));
        if (!await file.exists()) throw Exception('Нет файла ${p.basename(file.path)}');
        files.add(XFile(file.path, mimeType: 'image/jpeg'));
      }
      if (files.isEmpty) throw Exception('В станции нет фотографий');
      await SharePlus.instance.share(ShareParams(files: files));
    } catch (e) {
      if (mounted) setState(() => _status = 'Не удалось отправить: $e');
    }
  }

  Color _targetColor() {
    if (_capturing) return const Color(0xFFFFD45A);
    if (_targetLocked) return const Color(0xFF59E39A);
    if (_insideTarget) return const Color(0xFF49B8FF);
    return Colors.white;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _captureMode ? _buildCapture() : _buildStart(),
    );
  }

  Widget _buildStart() {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 22),
            const Text(
              'LUNARU Capture',
              style: TextStyle(fontSize: 31, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 4),
            const Text(
              'Нативная съёмка 360° · v0.4',
              style: TextStyle(color: Colors.white70, fontSize: 15),
            ),
            const SizedBox(height: 30),
            TextField(
              controller: _objectController,
              decoration: const InputDecoration(
                labelText: 'Объект',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _stationController,
              decoration: const InputDecoration(
                labelText: 'Станция',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 18),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: const Color(0xFF0F1821),
                borderRadius: BorderRadius.circular(14),
              ),
              child: Text(
                _motionAvailable
                    ? 'Датчики: готовы · порядок: горизонт → верх → низ → камера вверх → камера вниз'
                    : 'Датчики: проверка…',
                style: const TextStyle(color: Colors.white70),
              ),
            ),
            const Spacer(),
            OutlinedButton.icon(
              onPressed: _starting ? null : _showSavedStations,
              icon: const Icon(Icons.photo_library_outlined),
              label: const Text('Станции · отправить оригиналы'),
            ),
            FilledButton.icon(
              onPressed: _starting ? null : _startCapture,
              icon: const Icon(Icons.camera_alt_rounded),
              label: Padding(
                padding: const EdgeInsets.symmetric(vertical: 15),
                child: Text(_starting ? 'ЗАПУСК…' : 'НАЧАТЬ СЪЁМКУ'),
              ),
            ),
            const SizedBox(height: 12),
            Text(
              _status,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white60),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCapture() {
    final camera = _camera;
    final done = _current >= _targets.length;
    final color = _targetColor();
    final hold = _lockStarted == null ? 0.0 :
        (DateTime.now().difference(_lockStarted!).inMilliseconds /
            _holdDuration.inMilliseconds).clamp(0.0, 1.0);
    return SafeArea(
      child: Column(children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(children: [
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_stationController.text, maxLines: 1, overflow: TextOverflow.ellipsis),
              Text(done ? 'Готово' : _targets[_current].label,
                  style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold)),
            ])),
            _glassPill('${_frames.length}/32'),
          ]),
        ),
        Expanded(child: LayoutBuilder(builder: (context, bounds) {
          final ratio = camera != null && camera.value.isInitialized
              ? 1 / camera.value.aspectRatio : 3 / 4;
          final width = math.min(bounds.maxWidth, bounds.maxHeight * ratio);
          final height = width / ratio;
          return Center(child: SizedBox(width: width, height: height,
            child: ClipRect(child: Stack(fit: StackFit.expand, children: [
              if (camera != null && camera.value.isInitialized)
                CameraPreview(camera)
              else const Center(child: CircularProgressIndicator()),
              Center(child: SizedBox(width: 120, height: 120,
                child: Stack(alignment: Alignment.center, children: [
                  SizedBox.expand(child: CircularProgressIndicator(
                    value: _capturing ? null : hold,
                    color: color, backgroundColor: Colors.white54, strokeWidth: 4)),
                  Icon(done ? Icons.check : Icons.add, color: color, size: 32),
                ]))),
              if (!done) Align(
                alignment: Alignment(
                  (-_displayYaw / 45).clamp(-0.8, 0.8),
                  (_displayPitch / 45).clamp(-0.8, 0.8)),
                child: Container(width: 48, height: 48,
                  decoration: BoxDecoration(shape: BoxShape.circle,
                    color: Colors.black54, border: Border.all(color: color, width: 3)),
                  child: Center(child: Text(_guidanceArrow(),
                    style: TextStyle(color: color, fontSize: 28))))),
            ])),
          ));
        })),
        Padding(padding: const EdgeInsets.fromLTRB(12, 8, 12, 4), child: Column(children: [
          Text(done ? 'Станция снята полностью' : _capturing ? 'СОХРАНЯЮ КАДР…'
              : _motion == null ? 'Нет данных датчиков · доступна ручная съёмка'
              : _targetLocked ? 'ДЕРЖИТЕ · АВТОСЪЁМКА'
              : _insideTarget ? 'ДЕРЖИТЕ ТЕЛЕФОН НЕПОДВИЖНО' : 'СОВМЕСТИТЕ КРУЖОК С КРЕСТОМ',
            textAlign: TextAlign.center,
            style: TextStyle(color: color, fontWeight: FontWeight.bold)),
          if (!done && _motion != null)
            Text(_directionText(),
              style: const TextStyle(color: Colors.white70, fontSize: 12)),
          Text(_status, maxLines: 2, overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center, style: const TextStyle(fontSize: 12)),
          if (_lastShotSummary != null) Text(_lastShotSummary!,
            maxLines: 1, style: const TextStyle(fontSize: 11, color: Colors.white70)),
        ])),
        Padding(padding: const EdgeInsets.all(12), child: Column(children: [
          SizedBox(width: double.infinity, child: FilledButton.icon(
            onPressed: done || _capturing || _finishing ? null : () => _takePicture(auto: false),
            icon: const Icon(Icons.camera_alt), label: const Text('Снять вручную'))),
          Row(children: [
            Expanded(child: OutlinedButton(
              onPressed: _frames.isEmpty || _capturing || _finishing ? null : _retakePrevious,
              child: const FittedBox(child: Text('Переснять')))),
            const SizedBox(width: 12),
            Expanded(child: OutlinedButton(
              onPressed: _capturing || _finishing ? null : _finishStation,
              child: const FittedBox(child: Text('Завершить')))),
          ]),
        ])),
      ]),
    );
  }

  Widget _glassPill(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.62),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Colors.white24),
      ),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
    );
  }
}
