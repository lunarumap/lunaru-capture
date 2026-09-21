/* Small browser compatibility helpers; no changes to camera originals. */
'use strict';
window.LunaruCaptureSupport = (() => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function deadline(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), ms);
    })]).finally(() => clearTimeout(timer));
  }
  // W3C intrinsic Z-X-Y device orientation; rear camera looks along device -Z.
  // https://www.w3.org/TR/orientation-event/#a-1-calculating-compass-heading
  function cameraPose({alpha,beta,gamma}) {
    if (![alpha,beta,gamma].every(Number.isFinite)) return null;
    const r=Math.PI/180,a=alpha*r,b=beta*r,g=gamma*r;
    const x=-Math.cos(a)*Math.sin(g)-Math.sin(a)*Math.sin(b)*Math.cos(g);
    const y=-Math.sin(a)*Math.sin(g)+Math.cos(a)*Math.sin(b)*Math.cos(g);
    const z=-Math.cos(b)*Math.cos(g);
    return {yaw:(Math.atan2(x,y)/r+360)%360,pitch:Math.atan2(z,Math.hypot(x,y))/r};
  }
  function recorderOptions() {
    if (!window.MediaRecorder) throw new Error('Браузер не поддерживает запись видео. Откройте страницу в Safari или Chrome.');
    // Container only: the browser chooses a profile/level and bitrate for this stream.
    return ['video/mp4', 'video/webm;codecs=vp8'].filter(t => MediaRecorder.isTypeSupported(t))
      .map(mimeType => ({mimeType})).concat([{}]);
  }
  async function inspectVideo(blob) {
    const video = document.createElement('video'), url = URL.createObjectURL(blob);
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.style.cssText = 'position:fixed;left:-10000px;width:2px;height:2px';
    document.body.append(video);
    try {
      const decoded = new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('Сохранённое видео не воспроизводится в этом браузере.'));
      });
      video.src = url;
      await deadline(decoded, 6000, 'Не удалось проверить изображение в видео.');
      if (!video.videoWidth || !video.videoHeight) throw new Error('В видео нет изображения.');
      const ended=new Promise(resolve => {video.onended=resolve;});
      await deadline(video.play(), 3000, 'Не удалось начать воспроизведение видео.');
      await deadline(ended, 6000, 'Проверочное видео не завершило воспроизведение.');
      const seconds=Number.isFinite(video.duration)?video.duration:video.currentTime;
      const frames=video.getVideoPlaybackQuality?.().totalVideoFrames || video.webkitDecodedFrameCount;
      if (!(seconds>.3) || !frames) throw new Error('Не удалось измерить частоту кадров пробного видео.');
      return {width:video.videoWidth, height:video.videoHeight,
        durationMs:Math.round(seconds*1000),decodedFrames:frames,measuredFps:frames/seconds};
    } finally {
      video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
    }
  }
  async function probe(stream, options) {
    const recorder = new MediaRecorder(stream, options), chunks = [];
    let stopTimer, expiry;
    const blob = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(stopTimer); clearTimeout(expiry);
        recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch {}
        if (error) reject(error);
        else if (!chunks.length) reject(new Error('Кодек не выдал видео.'));
        else resolve(new Blob(chunks, {type:recorder.mimeType || options.mimeType || chunks[0].type}));
      };
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => finish(event.error || new Error('Кодек отказал при записи.'));
      recorder.onstop = () => finish();
      expiry = setTimeout(() => finish(new Error('Кодек не завершил проверочную запись.')), 4500);
      try {
        recorder.start();
        stopTimer = setTimeout(() => { try { recorder.stop(); } catch (e) { finish(e); } }, 1800);
      } catch (e) { finish(e); }
    });
    const decoded = await inspectVideo(blob);
    return {...decoded, mimeType:blob.type, bytes:blob.size, checkedAt:new Date().toISOString()};
  }
  // Circular yaw filter, with separate enter/leave thresholds: sensor noise near
  // a boundary must not keep cancelling a stable shot. Raw angles remain in metadata.
  class PhotoGuide {
    reset() { this.filtered = null; this.key = null; this.since = null; this.inside = false; }
    constructor() { this.reset(); }
    sample(raw, target, key, time) {
      const wrap = n => ((n + 540) % 360) - 180;
      const dt = this.filtered ? time - this.filtered.time : 0;
      let speed = 0;
      if (!this.filtered || dt > 350 || dt <= 0) this.filtered = {...raw, time};
      else {
        const weight = 1 - Math.exp(-dt / 85);
        const dy = wrap(raw.yaw - this.filtered.yaw) * weight;
        const dp = (raw.pitch - this.filtered.pitch) * weight;
        speed = Math.max(target.verticalOnly ? 0 : Math.abs(dy), Math.abs(dp)) / dt * 1000;
        this.filtered = {yaw:this.filtered.yaw + dy, pitch:this.filtered.pitch + dp, time};
      }
      if (this.key !== key || dt > 350) { this.key = key; this.since = null; this.inside = false; }
      const dy = target.verticalOnly ? 0 : wrap(this.filtered.yaw - target.yaw);
      const dp = this.filtered.pitch - target.pitch;
      const limit = target.verticalOnly ? (this.inside ? 12 : 10) : (this.inside ? 10 : 7);
      const rawNear = Math.abs(raw.pitch-target.pitch) < (target.verticalOnly ? 13 : 11)
        && (target.verticalOnly || Math.abs(wrap(raw.yaw-target.yaw)) < 11);
      this.inside = Math.abs(dy) < limit && Math.abs(dp) < limit && rawNear;
      if (!this.inside || speed > 28) this.since = null;
      else if (this.since === null) this.since = time;
      return {dy, dp, good:this.inside, progress:this.since===null?0:Math.min(1,(time-this.since)/450), ready:this.since !== null && time-this.since >= 450};
    }
  }
  return {delay, deadline, recorderOptions, inspectVideo, probe, PhotoGuide, cameraPose};
})();
