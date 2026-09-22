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
  function cameraError(message, name='CameraFrameError') {
    return Object.assign(new Error(message), {name});
  }
  function assertLive(track) {
    if (!track || track.readyState !== 'live' || track.enabled === false || track.muted)
      throw cameraError('Камера не передаёт изображение. Проверьте разрешение камеры в браузере.');
  }
  async function freshFrame(video, track) {
    assertLive(track);
    if (video.paused) await deadline(video.play(), 3000, 'Не удалось возобновить изображение камеры.');
    let callback, timer;
    try {
      await deadline(new Promise(resolve => {
        if (video.requestVideoFrameCallback) callback=video.requestVideoFrameCallback(resolve);
        else {
          const before=video.currentTime;
          timer=setInterval(()=>{if(video.readyState>=2 && video.currentTime>before)resolve();},50);
        }
      }),2500,'Камера не выдаёт новые кадры. Восстановите камеру.');
    } catch(e) { throw cameraError(e.message); }
    finally { if(callback!=null)video.cancelVideoFrameCallback?.(callback);clearInterval(timer); }
    assertLive(track);
    if(video.readyState<2 || !video.videoWidth || !video.videoHeight)
      throw cameraError('Камера ещё не передала изображение.');
  }
  function checkPixels(source) {
    // Small diagnostic sample only; the saved original is never resized.
    const canvas=document.createElement('canvas');canvas.width=canvas.height=24;
    try {
      const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,24,24);
      const pixels=ctx.getImageData(0,0,24,24).data;
      let max=0;
      for(let i=0;i<pixels.length;i+=4)max=Math.max(max,pixels[i],pixels[i+1],pixels[i+2]);
      if(max<=1)throw cameraError('Получен полностью чёрный кадр. Проверьте объектив и разрешение камеры; кадр не засчитан.','BlackFrameError');
    } finally { canvas.width=canvas.height=1; }
  }
  async function inspectPhoto(blob) {
    let bitmap;
    try { if(window.createImageBitmap)bitmap=await createImageBitmap(blob); } catch { /* Image decoder fallback. */ }
    if(bitmap){try{checkPixels(bitmap);return {width:bitmap.width,height:bitmap.height};}finally{bitmap.close();}}
    const img=new Image(),url=URL.createObjectURL(blob);
    try {
      await deadline(new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(cameraError('Не удалось прочитать снимок.'));img.src=url;}),4000,'Снимок не декодирован.');
      checkPixels(img);return {width:img.naturalWidth,height:img.naturalHeight};
    } finally { img.src='';URL.revokeObjectURL(url); }
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
    // Keep the probe visible and provide a direct gesture if Safari blocks play().
    const panel=document.createElement('div'),label=document.createElement('div'),button=document.createElement('button');
    panel.id='videoProbe';panel.style.cssText='position:fixed;z-index:1000;inset:15% 8%;padding:16px;background:#102330;color:white;border:2px solid #49b8ff;border-radius:16px;display:flex;flex-direction:column;gap:12px';
    label.textContent='Проверка видео · короткая проба, не входит в набор';
    video.style.cssText='width:100%;height:60%;min-height:100px;object-fit:contain';
    video.setAttribute('muted','');video.setAttribute('playsinline','');
    button.textContent='▶ Воспроизвести пробу';button.hidden=true;
    panel.append(label,video,button);document.body.append(panel);
    let callback=null,callbackFrames=0;
    if(video.requestVideoFrameCallback){
      const tick=()=>{callbackFrames++;callback=video.requestVideoFrameCallback(tick);};
      callback=video.requestVideoFrameCallback(tick);
    }
    try {
      const decoded = new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('Сохранённое видео не воспроизводится в этом браузере.'));
      });
      decoded.catch(()=>{});
      video.src = url;
      let playback=deadline(video.play(),3000,'Браузер не начал воспроизведение пробы.');
      // Attach rejection handler immediately: loading and playback happen concurrently.
      playback=playback.catch(async error=>{
        if(error.name!=='NotAllowedError')throw error;
        button.hidden=false;label.textContent='Нажмите «Воспроизвести пробу», чтобы разрешить проверку видео.';
        try{await deadline(new Promise((resolve,reject)=>{
          button.onclick=()=>{video.play().then(resolve,reject);};
        }),30000,'Проверка отменена: воспроизведение не разрешено.');}
        catch(e){throw Object.assign(new Error(e.message),{name:'PlaybackPermissionError'});}
        finally{button.hidden=true;}
      });
      const ended=new Promise(resolve=>{video.onended=resolve;});
      await playback;
      await deadline(decoded, 6000, 'Не удалось проверить изображение в видео.');
      if (!video.videoWidth || !video.videoHeight) throw new Error('В видео нет изображения.');
      let completed=true;
      await deadline(ended,6000,'Проба не завершилась.').catch(()=>{completed=false;});
      if(video.currentTime<.05)throw new Error('Пробное видео не воспроизводит движение.');
      const seconds=Number.isFinite(video.duration)?video.duration:video.currentTime;
      const frames=video.getVideoPlaybackQuality?.().totalVideoFrames || video.webkitDecodedFrameCount || callbackFrames;
      const measuredFps=completed&&seconds>.3&&seconds<10&&frames>1?frames/seconds:null;
      return {width:video.videoWidth, height:video.videoHeight,
        durationMs:Number.isFinite(seconds)?Math.round(seconds*1000):null,decodedFrames:frames||null,measuredFps,
        playbackVerified:true,measurementWarning:measuredFps===null?'Видео воспроизводится; браузер не дал надёжно измерить частоту кадров. Проверьте короткую запись перед проходом.':null};
    } finally {
      if(callback!==null)video.cancelVideoFrameCallback?.(callback);
      video.pause(); video.removeAttribute('src'); video.load(); panel.remove(); URL.revokeObjectURL(url);
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
    sample(raw, target, key, time, smoothingMs=85) {
      const wrap = n => ((n + 540) % 360) - 180;
      const dt = this.filtered ? time - this.filtered.time : 0;
      let speed = 0;
      if (!this.filtered || dt > 350 || dt <= 0) this.filtered = {...raw, time};
      else {
        const weight = 1 - Math.exp(-dt / smoothingMs);
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
  return {delay, deadline, recorderOptions, inspectVideo, probe, PhotoGuide, cameraPose, assertLive, freshFrame, checkPixels, inspectPhoto};
})();
