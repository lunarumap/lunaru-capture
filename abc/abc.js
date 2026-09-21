/* TEST 0.15: additive A/B/C experiment. base-013.js is the unchanged TEST 0.13. */
/* global $, targets, state, current, shots, baseYaw, stream, started, lastAngles,
   stableSince, autoLock, selectedMode, show, save, refreshHome, openStation,
   shoot, render, onOrientation, stopGpsWatch, startGpsWatch, orientPermission,
   tryPortraitLock, checkVisualOrientation, compatSummary, explainCameraError,
   pad, norm, autoObjectName, fflate */
"use strict";
(() => {
  const VERSION = '0.16.0', DATABASE = 'lunaru_capture_abc_v014';
  const support=window.LunaruCaptureSupport, photoGuide=new support.PhotoGuide();
  let videoOptions=null, playbackUrl=null, videoWriteError=null, poleRearm=null;
  const originalTargets = targets.map(t => ({...t}));
  const zigzag = Array.from({length:12}, (_, sector) =>
    (sector % 2 ? [-45,0,45] : [45,0,-45]).map(pitch => ({
      yawOffset:sector*30, pitch, sector:sector+1,
      label:`Сектор ${sector+1}/12 · ${pitch > 0 ? 'Верх' : pitch < 0 ? 'Низ' : 'Горизонт'}`
    }))).flat();
  const METHODS = {
    A:{folder:'S01-A_photo_3rings', title:'A · Фото, три круга',
      help:'12 кадров горизонта → 8 сверху → 8 снизу → 2 зенита → 2 надира. Порядок TEST 0.13.', grid:originalTargets},
    B:{folder:'S01-B_photo_zigzag', title:'B · Фото, один круг зигзагом',
      help:'12 секторов по 30°. В первом: верх → горизонт → низ; в следующем: низ → горизонт → верх. В конце — 2 зенита и 2 надира.',
      grid:[...zigzag, ...originalTargets.slice(-4)]},
    C:{folder:'S01-C_video_zigzag', title:'C · Видео, один круг зигзагом',
      help:'Один плавный оборот по 12 секторам: вверх → горизонт → вниз, затем обратно. Записывается исходное видео без звука. Завершите запись кнопкой. Кадры не извлекаются.', grid:zigzag}
  };
  let db, writes=Promise.resolve(), projects=[], shooting=false, stopping=false;
  let retakeIndex=null, photoAPI=null, photoSettings={}, photoSource='video-frame';
  let recorder=null, activeVideo=null, videoWrites=Promise.resolve(), videoError=null, videoFlushTimer=null;
  let videoStopped=null, videoDetach=null, videoDidStart=false, videoChunks=0, videoClock=0, videoAccumulated=0;
  let lastSensor=null, sensorAllowed=false, wakeLock=null, guideDwell=0;
  let readyCamera=null, downloadBusy=false, guardTimer=null, reviewOpen=false;
  const urls=new Set();
  const clone=v=>structuredClone(v), now=()=>new Date().toISOString();
  const method=()=>state.methods[state.activeMethod];
  const spec=()=>METHODS[state.activeMethod];
  const stamp=()=>`${Date.now()}-${crypto.randomUUID()}`;
  const mb=b=>`${(b/1048576).toFixed(1)} МБ`;
  const duration=ms=>`${pad(Math.floor(ms/60000))}:${pad(Math.floor(ms/1000)%60)}`;
  const report=e=>{
    console.error(e);
    $('status').classList.add('error');
    $('status').textContent=`Не удалось сохранить или выполнить действие: ${e.message || e}. Сохранённые файлы не удалены.`;
  };
  const message=text=>{$('status').classList.remove('error');$('status').textContent=text;};
  const safely=fn=>async (...args)=>{try{await fn(...args);}catch(e){report(e);}};
  function queue(fn){
    const job=writes.catch(()=>{}).then(fn); writes=job; return job;
  }
  function transaction(names, action){
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(names,'readwrite');
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error || new Error('Ошибка хранилища'));
      tx.onabort=()=>reject(tx.error || new Error('Запись отменена'));
      try{action(tx);}catch(e){tx.abort();reject(e);}
    });
  }
  function read(store,key){
    return new Promise((resolve,reject)=>{
      const req=db.transaction(store).objectStore(store).get(key);
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
  }
  function all(store){
    return new Promise((resolve,reject)=>{
      const req=db.transaction(store).objectStore(store).getAll();
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
  }
  function mirror(){
    const m=method(); current=retakeIndex ?? m.currentFrame;
    shots=m.shots; baseYaw=m.baseYaw ?? null;
    state.currentFrame=current;state.shots=shots;state.baseYaw=baseYaw;
    targets.splice(0,targets.length,...spec().grid.map(t=>({...t})));
  }
  async function persist(){
    if(!state || !db)return;
    const id=state.id;
    return queue(async()=>{
      if(state.id!==id)throw new Error('Объект изменился во время сохранения');
      state.updatedAt=now();method().baseYaw=state.baseYaw ?? baseYaw ?? null;
      await transaction(['projects'],tx=>tx.objectStore('projects').put(clone(state)));
    });
  }
  save=()=>{persist().catch(report);};
  const emptyMethod=()=>({currentFrame:0,shots:[],videos:[],baseYaw:null,finished:false,
    camera:null,download:null,revision:0,guideEvents:[],orientationModel:'rear-camera-v1'});
  async function mediaCommit(store,record,update){
    return queue(async()=>{
      const next=clone(state);update(next.methods[next.activeMethod]);
      next.updatedAt=now();
      await transaction(['projects',store],tx=>{
        tx.objectStore(store).put(record);tx.objectStore('projects').put(next);
      });
      state=next;mirror();
    });
  }
  function sensorLive(){return sensorAllowed && lastSensor && performance.now()-lastSensor.received<2000;}
  function orientation(){
    if(!sensorLive())return null;
    return {yaw:lastAngles?.yaw ?? null,pitch:lastAngles?.pitch ?? null,
      alpha:lastSensor.alpha,beta:lastSensor.beta,gamma:lastSensor.gamma,
      compassHeading:lastSensor.heading,absolute:lastSensor.absolute,
      screenAngle:screen.orientation?.angle ?? window.orientation ?? null,
      convention:method().orientationModel==='rear-camera-v1'?'Rear camera -Z, W3C Z-X-Y; relative sensor yaw, optical pitch; not surveyed azimuth':'TEST 0.13 legacy: yaw=compass or 360-alpha; pitch=beta-90',
      measuredAt:lastSensor.time};
  }
  function formatCamera(c){
    return `${c.width} × ${c.height} · ${Number(c.recordingCheck?.measuredFps||c.frameRate||0).toFixed(1)} fps${c.recordingCheck?' в пробе':''}${c.zoom!=null ? ` · зум ${c.zoom}×` : ''}`;
  }
  function downloadText(m){
    if(!m.download || m.download.revision!==m.revision)return 'Этот состав набора ещё не скачивался.';
    return m.download.confirmed ? 'Вы подтвердили: ZIP есть в «Загрузках».' : 'Скачивание передано браузеру. Проверьте папку «Загрузки».';
  }
  function summary(key){
    const m=state.methods[key];
    if(key==='C')return `${m.videos.filter(v=>v.chunks>0).length} видео · ${duration(m.videos.reduce((s,v)=>s+(v.savedMs||0),0))} · ${mb(m.videos.reduce((s,v)=>s+v.bytes,0))}${m.finished ? ' · проход завершён' : ''}${m.videos.some(v=>v.status==='interrupted') ? ' · есть прерванная запись, проверьте воспроизведение' : ''}`;
    return `${m.shots.filter(Boolean).length}/${METHODS[key].grid.length} кадров · осталось ${METHODS[key].grid.length-m.shots.filter(Boolean).length} · ${mb(m.shots.filter(Boolean).reduce((s,f)=>s+f.bytes,0))}`;
  }
  function makeButton(text, cls, fn){
    const b=document.createElement('button');b.className=cls;b.textContent=text;b.onclick=safely(fn);return b;
  }
  refreshHome=async()=>{
    if(!db)return;
    projects=(await all('projects')).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    $('savedObjects').replaceChildren();
    for(const p of projects){
      const b=makeButton('', 'alt',async()=>{await writes;state=await read('projects',p.id);retakeIndex=null;mirror();await openStation();});
      const title=document.createElement('b');title.textContent=p.objectName;
      const desc=document.createElement('span');desc.textContent=`S01 · A: ${p.methods.A.shots.filter(Boolean).length}/32 · B: ${p.methods.B.shots.filter(Boolean).length}/40 · C: ${p.methods.C.videos.filter(v=>v.chunks>0).length} видео`;
      b.append(title,desc);$('savedObjects').append(b);
    }
    $('bootStatus').textContent=projects.length ? 'Сохранённые объекты — открыть, продолжить или скачать:' : 'Создайте объект. Все три способа останутся в одной станции S01.';
  };
  async function storageInfo(){
    try{
      const [e,p]=await Promise.all([navigator.storage?.estimate(),navigator.storage?.persisted()]);
      $('storageStatus').textContent=`Исходники хранятся в этом браузере. ${e ? `Свободно около ${mb(e.quota-e.usage)}. ` : ''}${p ? 'Хранилище защищено от автоматической очистки браузером.' : 'Скачайте ZIP перед очисткой браузера; постоянное хранение браузером не гарантировано.'}`;
    }catch{$('storageStatus').textContent='Исходники хранятся в этом браузере. Обязательно скачайте наборы.';}
  }
  openStation=async()=>{
    mirror();show('stationStart');
    $('captureUi').classList.remove('active');$('actions').classList.remove('active');
    $('stationTitle').textContent='Одна точка · S01';$('stationObject').textContent=state.objectName;
    $('stationName').value=state.stationName||'';
    $('stationMode').textContent=({'indoor':'Помещение','outdoor-gps':'Улица · GPS','outdoor-no-gps':'Улица · без GPS'})[state.mode];
    $('gpsLine').textContent=state.gps ? `Координаты сохранены · ±${Math.round(state.gps.accuracy)} м` : 'Снимайте все три способа с одного места.';
    $('compatLine').textContent='A и B: исходные фото, C: исходное видео. Покрытие сферы здесь не проверяется.';
    $('methodChooser').replaceChildren();
    for(const key of Object.keys(METHODS)){
      const b=makeButton('','method',async()=>{await writes;state.activeMethod=key;retakeIndex=null;mirror();await persist();openStation();});
      b.dataset.method=key;b.setAttribute('aria-pressed',String(state.activeMethod===key));
      const title=document.createElement('b');title.textContent=METHODS[key].title;
      const progress=document.createElement('span');progress.textContent=summary(key);
      b.append(title,progress);$('methodChooser').append(b);
    }
    $('methodHelp').textContent=spec().help;
    $('startStationBtn').textContent=method().finished ? 'ОТКРЫТЬ КАМЕРУ / ДОСНЯТЬ' : 'ОТКРЫТЬ КАМЕРУ';
    renderExports();storageInfo();
  };
  function renderExports(){
    $('exportPanel').replaceChildren();
    for(const key of Object.keys(METHODS)){
      const m=state.methods[key],count=m.shots.filter(Boolean).length+m.videos.filter(v=>v.chunks>0).length;
      const box=document.createElement('div');box.className='exportSet';box.dataset.export=key;
      const title=document.createElement('strong');title.textContent=METHODS[key].folder;
      const info=document.createElement('small');
      info.textContent=count ? `Сохранено на устройстве: ${summary(key)}. ${downloadText(m)}` : 'Материала пока нет.';
      const b=makeButton(`Скачать ${key} · ZIP`, 'alt',()=>exportSet(key));b.disabled=!count || downloadBusy;
      box.append(title,info,b);
      if(key==='C')for(const v of m.videos.filter(v=>v.chunks>0)){
        box.append(makeButton(`▶ Проверить ${v.filename}`, 'alt',()=>playSavedVideo(v)));
      }
      if(m.download && m.download.revision===m.revision && !m.download.confirmed){
        box.append(makeButton('Файл вижу в «Загрузках»','alt',async()=>{
          state.methods[key].download.confirmed=true;await persist();renderExports();
        }));
      }
      $('exportPanel').append(box);
    }
  }
  async function videoBlob(v){
    const parts=[];
    for(let i=0;i<v.chunks;i++){
      const chunk=await read('chunks',`${v.id}:${i}`);
      if(!chunk?.blob)throw new Error('Не найдена часть видео. Сохранённые данные оставлены на месте.');
      parts.push(chunk.blob);
    }
    return new Blob(parts,{type:v.mimeType});
  }
  async function playSavedVideo(v){
    await writes;
    if(playbackUrl)URL.revokeObjectURL(playbackUrl);
    playbackUrl=URL.createObjectURL(await videoBlob(v));
    const player=$('savedVideo');
    $('videoReviewInfo').textContent=`${v.filename} · ${v.width} × ${v.height} · ${mb(v.bytes)}${v.status==='interrupted'?' · прерванная запись':''}`;
    $('playbackStatus').textContent='Нажмите ▶ и проверьте изображение и движение.';
    player.onerror=()=>{$('playbackStatus').textContent='Браузер не смог воспроизвести файл. Исходник сохранён; его можно скачать для проверки.';};
    player.ontimeupdate=()=>{if(player.currentTime>0.2)$('playbackStatus').textContent='Видео воспроизводится. Проверьте весь проход, затем скачайте ZIP.';};
    player.src=playbackUrl;show('videoReview');
  }
  $('closeVideoReviewBtn').onclick=safely(async()=>{
    const player=$('savedVideo');player.pause();player.removeAttribute('src');player.load();
    if(playbackUrl){URL.revokeObjectURL(playbackUrl);playbackUrl=null;}
    await openStation();
  });
  $('newBtn').onclick=()=>{
    selectedMode=null;$('objectName').value='';$('createBtn').textContent='НАЧАТЬ ОБЪЕКТ';
    $('createBtn').disabled=true;document.querySelectorAll('.modebtn').forEach(b=>b.classList.remove('sel'));show('newObject');
  };
  $('backBtn').onclick=safely(async()=>{if($('createBtn').textContent==='СОХРАНИТЬ РЕЖИМ' && state)await openStation();else{await refreshHome();show('home');}});
  $('createBtn').onclick=safely(async()=>{
    if(!selectedMode)return;
    await writes;
    if($('createBtn').textContent==='СОХРАНИТЬ РЕЖИМ' && state){
      state.objectName=$('objectName').value.trim() || state.objectName;state.mode=selectedMode;
    }else{
      state={id:crypto.randomUUID(),schema:1,version:VERSION,objectName:$('objectName').value.trim()||autoObjectName(),
        mode:selectedMode,station:1,stationName:'',gps:null,createdAt:now(),updatedAt:now(),
        activeMethod:'A',methods:{A:emptyMethod(),B:emptyMethod(),C:emptyMethod()},objectFinished:false};
    }
    retakeIndex=null;mirror();await persist();await openStation();
  });
  $('finishObjectBtn').textContent='К СПИСКУ ОБЪЕКТОВ · ДАННЫЕ ОСТАНУТСЯ';
  $('finishObjectBtn').onclick=safely(async()=>{await persist();show('home');await refreshHome();message('Все исходники остаются в объекте. Их можно доснять и скачать.');});

  async function openRearCamera(){
    if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)throw new Error('Для камеры откройте этот адрес по HTTPS в Chrome.');
    const previous=method().camera;
    const identity=previous?.deviceId ? {deviceId:{exact:previous.deviceId}} : {facingMode:{exact:'environment'}};
    let s;
    try{s=await navigator.mediaDevices.getUserMedia({audio:false,video:{...identity,width:{ideal:3840},height:{ideal:2160},frameRate:{ideal:30}}});}
    catch(e){
      if(e.name!=='OverconstrainedError')throw e;
      // Keep the rear/pinned device constraint even on the low-resolution fallback.
      s=await navigator.mediaDevices.getUserMedia({audio:false,video:identity});
    }
    const track=s.getVideoTracks()[0];
    try{
      const caps=track.getCapabilities?.() || {};
      if(previous?.zoom!=null && caps.zoom)await track.applyConstraints({advanced:[{zoom:previous.zoom}]});
      const settings=track.getSettings();
      if(settings.facingMode && settings.facingMode!=='environment')throw new Error('Открылась фронтальная камера. Нужна задняя камера.');
      if(previous?.deviceId && previous.deviceId!==settings.deviceId)throw new Error('Не удалось открыть тот же объектив.');
      if(previous?.zoom!=null && settings.zoom!=null && Math.abs(previous.zoom-settings.zoom)>.01)throw new Error('Не удалось восстановить прежний зум.');
      return s;
    }catch(e){s.getTracks().forEach(t=>t.stop());throw e;}
  }
  function cameraSnapshot(){
    const track=stream.getVideoTracks()[0], settings=track.getSettings();
    return {...settings,width:$('video').videoWidth||settings.width,height:$('video').videoHeight||settings.height,
      label:track.label,requested:{width:3840,height:2160,frameRate:30,facingMode:'environment'},openedAt:now()};
  }
  async function prepareVideo(){
    const options=support.recorderOptions(), attempts=[];
    const track=stream.getVideoTracks()[0], initial=track.getSettings();
    // One preferred codec at requested resolution, then a modest number of lower
    // modes. All constraints apply to the SAME track before the pass starts.
    const candidates=[{long:null,options:options[0]},
      {long:1920,options:options[0]},
      {long:1920,options:options[1]||{}},
      {long:1280,options:{}},{long:854,options:{},fps:15}];
    for(const candidate of candidates){
      try{
        if(candidate.long){
          const portrait=initial.height>initial.width, short=Math.round(candidate.long*9/16);
          await track.applyConstraints({width:{ideal:portrait?short:candidate.long,max:portrait?short:candidate.long},
            height:{ideal:portrait?candidate.long:short,max:portrait?candidate.long:short},frameRate:{ideal:candidate.fps||30,max:candidate.fps||30}});
          await support.delay(150);
        }
        const settings=track.getSettings();
        if(initial.deviceId && settings.deviceId!==initial.deviceId)throw new Error('Изменился объектив.');
        if(initial.zoom!=null && settings.zoom!=null && Math.abs(initial.zoom-settings.zoom)>.01)throw new Error('Изменился зум.');
        $('cameraInfo').textContent=`Проверяю запись: ${formatCamera(cameraSnapshot())}`;
        $('photoInfo').textContent='Короткая пробная запись и проверка воспроизведения. Она не входит в набор. Подождите несколько секунд…';
        message(candidate.long ? `Проверяю доступный режим до ${candidate.long} px…` : 'Проверяю, может ли браузер записать видео…');
        const verification=await support.probe(stream,candidate.options);
        if(verification.measuredFps<12)throw new Error(`Слишком медленная запись: ${verification.measuredFps.toFixed(1)} кадр/с в пробе.`);
        videoOptions=candidate.options;
        readyCamera={...cameraSnapshot(),width:verification.width,height:verification.height,
          recordingCheck:verification,recordingAttempts:attempts};
        return;
      }catch(e){attempts.push({limit:candidate.long,mimeType:candidate.options.mimeType||'browser-default',error:e.message});}
    }
    throw new Error(`Видео не запустилось ни в одном проверенном режиме. ${attempts.at(-1)?.error||''} Попробуйте открыть эту ссылку в обычном Safari на iPhone или Chrome на Android.`);
  }
  async function setupPhoto(){
    photoAPI=null;photoSource='video-frame';photoSettings={};
    if(!window.ImageCapture)return;
    try{
      photoAPI=new ImageCapture(stream.getVideoTracks()[0]);
      if(typeof photoAPI.takePhoto!=='function'){photoAPI=null;return;}
      try{
        const c=await photoAPI.getPhotoCapabilities();
        if(c.imageWidth?.max)photoSettings.imageWidth=c.imageWidth.max;
        if(c.imageHeight?.max)photoSettings.imageHeight=c.imageHeight.max;
      }catch{/* takePhoto can still return the camera's available photo mode. */}
      photoSource='image-capture';
    }catch{photoAPI=null;}
  }
  function photoDescription(){
    return photoSource==='image-capture'
      ? `Фото через API камеры${photoSettings.imageWidth ? `: запрос ${photoSettings.imageWidth} × ${photoSettings.imageHeight}` : ': доступное разрешение'}. Фактический размер проверяется после снимка. JPEG не пересжимается.`
      : `Доступен только кадр видеопотока: ${$('video').videoWidth} × ${$('video').videoHeight}. Это не полноразмерное фото камеры. Сохраняем JPEG без уменьшения разрешения.`;
  }
  async function releaseCamera(){
    reviewOpen=false;started=false;clearInterval(guardTimer);guardTimer=null;
    stopGpsWatch();
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
    $('video').srcObject=null;
    if(wakeLock){try{await wakeLock.release();}catch{}wakeLock=null;}
    $('captureUi').classList.remove('active');$('actions').classList.remove('active');
  }
  $('startStationBtn').onclick=safely(async()=>{
    // iOS requires requestPermission in the click stack, before any await/IDB work.
    const permission=orientPermission();
    $('startStationBtn').disabled=true;$('confirmCameraBtn').disabled=true;$('cancelCameraBtn').disabled=true;
    try{
      message('Открываю заднюю камеру…');state.stationName=$('stationName').value.trim();await persist();
      sensorAllowed=await permission;await tryPortraitLock();photoGuide.reset();
      stream=await openRearCamera();$('video').srcObject=stream;await $('video').play();
      readyCamera=cameraSnapshot();
      if(!readyCamera.width || !readyCamera.height)throw new Error('Камера не передаёт изображение.');
      reviewOpen=true;show('cameraReview');$('reviewTitle').textContent=spec().title;
      if(state.activeMethod==='C')await prepareVideo();else await setupPhoto();
      $('cameraInfo').textContent=`Задняя камера · фактически ${formatCamera(readyCamera)}`;
      $('photoInfo').textContent=state.activeMethod==='C'
        ? `Запрошено 4K (3840 × 2160). ${Math.max(readyCamera.width,readyCamera.height)<3840 ? '4K не получено для записи: будет использован показанный выше проверенный режим.' : '4K прошло проверку записи.'} Короткое видео записано и воспроизведено. Формат: ${readyCamera.recordingCheck.mimeType}. Без звука.`
        : photoDescription();
      $('confirmCameraBtn').textContent=state.activeMethod==='C' ? 'НАЧАТЬ ЗАПИСЬ ВИДЕО' : 'НАЧАТЬ ФОТОСЪЁМКУ';
      await navigator.storage?.persist?.().catch(()=>false);
      updateSensorText();message('Проверьте параметры перед началом.');
    }catch(e){await releaseCamera();await openStation();throw e;}
    finally{$('startStationBtn').disabled=false;$('confirmCameraBtn').disabled=false;$('cancelCameraBtn').disabled=false;}
  });
  $('cancelCameraBtn').onclick=safely(async()=>{await releaseCamera();await openStation();});
  $('confirmCameraBtn').onclick=safely(async()=>{
    $('confirmCameraBtn').disabled=true;$('cancelCameraBtn').disabled=true;
    try{
      photoGuide.reset();
      if(!stream)throw new Error('Камера закрыта. Откройте её снова.');
      if(!method().orientationModel){
        const hasOriginals=method().shots.some(Boolean)||method().videos.some(v=>v.chunks>0);
        method().orientationModel=hasOriginals&&method().baseYaw!=null?'legacy-013':'rear-camera-v1';
        if(!hasOriginals)method().baseYaw=state.baseYaw=baseYaw=null;
      }
      method().camera={...readyCamera};method().photoSource=photoSource;method().photoRequest=clone(photoSettings);
      method().finished=false;await persist();mirror();reviewOpen=false;
      if(state.activeMethod==='C'){message('Запускаю запись и ожидаю первые сохранённые данные…');await startVideo();}
      document.querySelectorAll('.screen').forEach(el=>el.classList.remove('active'));
      $('captureUi').classList.add('active');$('actions').classList.add('active');
      $('objectPill').textContent=state.objectName;$('stationPill').textContent=`S01-${state.activeMethod}`;
      $('captureMethod').textContent=spec().title;
      $('captureFormat').textContent=state.activeMethod==='C' ? formatCamera(readyCamera) : `${photoSource==='image-capture'?'Фото API камеры':'Кадр видеопотока'} · ${readyCamera.width} × ${readyCamera.height}`;
      $('retakeBtn').textContent=state.activeMethod==='C' ? 'Пауза видео' : 'Переснять последний';
      $('manualBtn').textContent=state.activeMethod==='C' ? 'Следующее направление' : 'Снять вручную';
      $('finishStationBtn').textContent='Завершить способ';
      started=true;stopping=false;
      if(state.mode==='outdoor-gps')startGpsWatch();else stopGpsWatch();
      checkVisualOrientation();render();
      try{wakeLock=await navigator.wakeLock?.request('screen');}catch{}
      clearInterval(guardTimer);guardTimer=setInterval(safely(checkCamera),1000);
      message('Снимайте с одной точки. Сохранённое покрытие проверим при сшивке.');
    }catch(e){
      if(recorder){try{await stopVideo();}catch{}}
      await releaseCamera();await openStation();throw e;
    }
    finally{$('confirmCameraBtn').disabled=false;$('cancelCameraBtn').disabled=false;}
  });
  async function checkCamera(){
    if(!stream || stopping)return;
    if(started && recorder?.state==='inactive' && !videoError)videoError=new Error('Браузер прервал запись видео.');
    if(recorder && videoError){await stopPass(false);return;}
    const t=stream.getVideoTracks()[0], c=t.getSettings(), initial=method().camera;
    if(t.readyState==='ended' || (initial.deviceId && c.deviceId!==initial.deviceId) ||
        (initial.zoom!=null && c.zoom!=null && Math.abs(initial.zoom-c.zoom)>.01)){
      await stopPass(false);message('Камера или зум изменились. Проход остановлен; сохранённые исходники доступны.');
    }
  }
  function updateSensorText(){
    const text=sensorLive() ? 'Датчики работают · направление приблизительное' : state.activeMethod==='C'
      ? 'Нет данных ориентации · направление меняйте кнопкой; запись видео работает независимо'
      : 'Нет данных ориентации · наведите телефон по подсказке и нажмите «Снять вручную»';
    for(const id of ['sensorReviewBtn','sensorCaptureBtn'])$(id).hidden=!!sensorLive() || typeof window.DeviceOrientationEvent?.requestPermission!=='function';
    $('sensorInfo').textContent=text+(method().orientationModel==='legacy-013'?' · Старый набор: сохранена прежняя система углов. Новый прицел проверяйте в новом объекте.':'');
    $('captureSensors').textContent=sensorLive()?'Датчики работают':'Нет ориентации · ручная съёмка';
    if(started && !sensorLive()){
      stableSince=0;autoLock=false;guideDwell=0;photoGuide.reset();manualGuide();
    }
  }
  for(const id of ['sensorReviewBtn','sensorCaptureBtn'])$(id).onclick=safely(async()=>{
    const permission=orientPermission();sensorAllowed=await permission;photoGuide.reset();updateSensorText();
    message(sensorAllowed?'Доступ к датчикам разрешён. Плавно поверните телефон.':'Доступ не получен. Откройте ссылку в Safari/Chrome и разрешите датчики; ручная съёмка доступна.');
  });
  function manualGuide(){
    $('aimDot').hidden=true;$('aimProgress').style.strokeDashoffset='314';
    const t=targets[current];if(!t)return;
    $('guideMain').textContent=t.label;
    $('guideSub').textContent=`${t.verticalOnly ? 'Отдельный кадр; меняйте наклон, не место.' : `Поворот от начала ${t.yawOffset}° · наклон ${t.pitch>0?'+':''}${t.pitch}°.`} ${state.activeMethod==='C' ? 'Ведите плавно; затем «Следующее направление».' : 'Нажмите «Снять вручную».'}`;
    $('directionArrow').textContent=t.pitch>0?'↑':t.pitch<0?'↓':'→';
  }
  const originalRender=render;
  render=()=>{
    if(!state)return;
    originalRender();photoGuide.reset();$('aimDot').hidden=true;$('aimProgress').style.strokeDashoffset='314';
    const m=method();
    $('counter').textContent=state.activeMethod==='C' ? duration(videoElapsed()) : `${m.shots.filter(Boolean).length} / ${targets.length}`;
    if(retakeIndex!=null)$('guideSub').textContent=`Переснять кадр ${retakeIndex+1}. Старый снимок сохранён до замены.`;
    if(!targets[current]){
      $('guideMain').textContent=state.activeMethod==='C' ? 'Обход выполнен · остановите запись' : 'Все запланированные кадры сняты';
      $('guideSub').textContent='Полнота сферы ещё не проверена. Нажмите «Завершить способ».';
    }else if(!sensorLive())manualGuide();
    $('manualBtn').disabled=!targets[current] || shooting;
    $('retakeBtn').disabled=shooting || (state.activeMethod!=='C' && !m.shots.filter(Boolean).length);
    $('durableStatus').textContent=state.activeMethod==='C'
      ? `Видео записывается частями на устройство; сохранено ${duration(activeVideo?.savedMs||0)}`
      : `На устройстве: ${m.shots.filter(Boolean).length} кадров`;
  };
  function guidePhoto(){
    const t=targets[current];if(!t || !sensorLive())return;
    if(t.verticalOnly&&targets[current-1]?.verticalOnly&&targets[current-1].pitch===t.pitch){
      if(poleRearm!==current){
        if(Math.abs(lastAngles.pitch)<55)poleRearm=current;
        else{drawAim(0,lastAngles.pitch,false);$('guideMain').textContent='Смените направление для второго кадра';$('guideSub').textContent='Верните камеру к горизонту, немного поверните и снова наведите вверх/вниз.';return;}
      }
    }
    if(baseYaw===null && !t.verticalOnly){
      if(Math.abs(lastAngles.pitch)>18){
        $('guideMain').textContent='Сначала направьте камеру на горизонт';
        $('directionArrow').textContent=lastAngles.pitch>0?'↓':'↑';return;
      }
      baseYaw=lastAngles.yaw;state.baseYaw=baseYaw;method().baseYaw=baseYaw;save();
    }
    const guide=photoGuide.sample(lastAngles,{...t,yaw:norm((baseYaw||0)+t.yawOffset)},current,performance.now());
    drawAim(guide.dy,guide.dp,guide.good,guide.progress);
    $('target').classList.toggle('good',guide.good);
    if(guide.good){
      $('directionArrow').textContent='✓';$('guideMain').textContent='Замрите на мгновение';
      $('guideSub').textContent=`Автоснимок · ${current+1}/${targets.length}`;
      if(guide.ready && !autoLock){autoLock=true;shoot(true);}
    }else{
      autoLock=false;
      const vertical=t.verticalOnly || Math.abs(guide.dp)>=7;
      $('directionArrow').textContent=vertical ? (guide.dp<0?'↑':'↓') : (guide.dy<0?'→':'←');
      $('guideMain').textContent=t.label;
      $('guideSub').textContent=vertical ? (guide.dp<0?'Плавно поднимите телефон':'Плавно опустите телефон') : (guide.dy<0?'Плавно повернитесь вправо':'Плавно повернитесь влево');
    }
  }
  function drawAim(dy,dp,good,progress=0){
    const area=$('aimArea'),dot=$('aimDot'),clamp=n=>Math.max(-1,Math.min(1,n));
    dot.hidden=false;dot.style.left=`${50+clamp(-dy/45)*40}%`;dot.style.top=`${50+clamp(dp/45)*40}%`;
    dot.classList.toggle('good',good);$('aimProgress').style.strokeDashoffset=String(314*(1-progress));
  }
  const originalOrientation=onOrientation;
  window.removeEventListener('deviceorientation',originalOrientation,true);
  window.addEventListener('deviceorientation',e=>{
    const heading=Number.isFinite(e.webkitCompassHeading)?e.webkitCompassHeading:null;
    const pose=support.cameraPose(e);if(!pose)return;
    lastSensor={alpha:e.alpha,beta:e.beta,gamma:e.gamma,heading,absolute:e.absolute===true,time:now(),received:performance.now()};
    lastAngles=state?.methods?.[state.activeMethod]?.orientationModel==='legacy-013'
      ? {yaw:norm(heading ?? (360-e.alpha)),pitch:Math.max(-90,Math.min(90,e.beta-90))}:pose;
    if(!started || stopping || shooting || retakeIndex!=null || window.innerWidth>window.innerHeight)return;
    if(state.activeMethod!=='C'){guidePhoto();return;}
    if(!recorder || recorder.state!=='recording')return;
    const t=targets[current];if(!t)return;
    if(baseYaw===null){
      if(Math.abs(lastAngles.pitch)>18){$('guideMain').textContent='Сначала направьте камеру на горизонт';return;}
      baseYaw=lastAngles.yaw;state.baseYaw=baseYaw;method().baseYaw=baseYaw;save();
    }
    const dy=((lastAngles.yaw-(baseYaw+t.yawOffset)+540)%360)-180,dp=lastAngles.pitch-t.pitch;
    const good=Math.abs(dy)<10 && Math.abs(dp)<10;
    drawAim(dy,dp,good);
    $('target').classList.toggle('good',good);
    $('guideMain').textContent=t.label;
    $('guideSub').textContent=`Плавно ${Math.abs(dp)>10 ? (dp<0?'вверх':'вниз') : Math.abs(dy)>10 ? (dy<0?'вправо':'влево') : 'пройдите направление'} · ${current+1}/${targets.length}`;
    $('directionArrow').textContent=Math.abs(dp)>10 ? (dp<0?'↑':'↓') : Math.abs(dy)>10 ? (dy<0?'→':'←') : '✓';
    if(!good){guideDwell=0;return;}
    if(!guideDwell)guideDwell=performance.now();
    if(performance.now()-guideDwell>350)advanceVideoGuide('sensor');
  },true);
  setInterval(()=>{
    if(reviewOpen || started)updateSensorText();
    if(started && state.activeMethod==='C'){
      $('counter').textContent=`${recorder?.state==='paused'?'ПАУЗА':'● REC'} ${duration(videoElapsed())}`;
      $('durableStatus').textContent=`${recorder?.state==='paused' ? 'Пауза · ' : ''}Сохранено на устройстве: ${duration(activeVideo?.savedMs||0)}. Перед закрытием — «Остановить и сохранить».`;
    }
  },500);
  function canvasBlob(){
    const v=$('video'),c=$('canvas');
    if(!v.videoWidth || !v.videoHeight)throw new Error('Видеопоток не готов');
    c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);
    return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('Кадр не получен')),'image/jpeg',.95));
  }
  async function dimensions(blob){
    const bitmap=await createImageBitmap(blob);const size={width:bitmap.width,height:bitmap.height};bitmap.close();return size;
  }
  shoot=async auto=>{
    if(!started || stopping || shooting || state.activeMethod==='C' || !targets[current])return;
    if(window.innerWidth>window.innerHeight){message('Для прежней сетки TEST 0.13 держите телефон вертикально.');return;}
    shooting=true;$('manualBtn').disabled=true;$('retakeBtn').disabled=true;
    const index=current,time=now(),angles=orientation(),target={...targets[index],yaw:targets[index].verticalOnly || baseYaw===null ? null:norm(baseYaw+targets[index].yawOffset)};
    message(`Сохраняю кадр ${index+1}…`);
    try{
      let blob;
      if(photoSource==='image-capture'){
        try{
          try{blob=await support.deadline(photoAPI.takePhoto(photoSettings),6000,'Фото-API не ответило за 6 секунд.');}
          catch(e){
            if(e.name==='TimeoutError'||!Object.keys(photoSettings).length)throw e;
            blob=await support.deadline(photoAPI.takePhoto(),4000,'Фото-API не ответило.');photoSettings={};
          }
        }catch(e){
          // Explicit confirmation is required before switching from native photo to video frame.
          started=false;photoAPI=null;photoSource='video-frame';reviewOpen=true;
          $('captureUi').classList.remove('active');$('actions').classList.remove('active');show('cameraReview');
          $('photoInfo').textContent=`Фото-API не смогло сделать снимок (${e.name || 'ошибка'}). ${photoDescription()} Нажмите «НАЧАТЬ ФОТОСЪЁМКУ», если этот режим подходит.`;
          message('Кадр не добавлен. Подтвердите режим кадра видеопотока.');return;
        }
      }else blob=await canvasBlob();
      const size=await dimensions(blob),id=stamp();
      const extension=({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif','image/avif':'avif'})[blob.type] || 'bin';
      const item={id,index:index+1,filename:`frame_${pad(index+1)}.${extension}`,time,method:state.activeMethod,
        ...size,bytes:blob.size,mimeType:blob.type,source:photoSource,photoRequest:clone(photoSettings),
        camera:clone(readyCamera),angles,target,auto:!!auto};
      await mediaCommit('files',{id,projectId:state.id,blob},m=>{
        m.shots[index]=item;m.currentFrame=Math.max(m.currentFrame,index+1);m.revision++;
        m.finished=m.shots.filter(Boolean).length===spec().grid.length;
      });
      retakeIndex=null;mirror();
      $('flash').classList.remove('on');void $('flash').offsetWidth;$('flash').classList.add('on');
      $('captureFormat').textContent=`${photoSource==='image-capture'?'Фото API камеры':'Кадр видеопотока'} · ${size.width} × ${size.height}`;
      message(`Кадр ${index+1} сохранён на устройстве · ${size.width} × ${size.height}`);
    }catch(e){
      autoLock=true;stableSince=0;started=false;
      retakeIndex=null;await releaseCamera();await openStation();report(e);
    }finally{shooting=false;render();}
  };
  $('manualBtn').onclick=safely(async()=>{
    if(!started || stopping)return;
    if(state.activeMethod==='C')await advanceVideoGuide('manual');else await shoot(false);
  });
  $('retakeBtn').onclick=safely(async()=>{
    if(!started || shooting || stopping)return;
    if(state.activeMethod==='C')return togglePause();
    if(retakeIndex!=null){retakeIndex=null;mirror();render();return;}
    if(!method().shots.length)return;
    retakeIndex=method().shots.length-1;mirror();render();message('Следующий ручной снимок заменит последний. Старый файл не удаляется.');
  });
  function videoElapsed(){return videoAccumulated+(videoClock?performance.now()-videoClock:0);}
  async function startVideo(){
    if(!videoOptions)throw new Error('Сначала выполните проверку записи.');
    recorder=new MediaRecorder(stream,videoOptions);
    const currentRecorder=recorder, actualMime=recorder.mimeType||videoOptions.mimeType||readyCamera.recordingCheck.mimeType;
    activeVideo={id:stamp(),filename:`video_${pad(method().videos.length+1)}.${actualMime.includes('mp4')?'mp4':'webm'}`,
      method:'C',time:now(),width:readyCamera.width,height:readyCamera.height,frameRate:readyCamera.frameRate,
      mimeType:actualMime,bitsPerSecond:recorder.videoBitsPerSecond,audio:false,camera:clone(readyCamera),
      chunks:0,bytes:0,savedMs:0,status:'recording',guideStart:current};
    const videoId=activeVideo.id;
    videoWrites=Promise.resolve();videoChunks=0;videoError=null;videoWriteError=null;
    videoAccumulated=0;videoClock=0;videoDidStart=false;
    let resolveData,rejectData,acceptData=true;
    const firstData=new Promise((resolve,reject)=>{resolveData=resolve;rejectData=reject;});
    // The first chunk can fail while metadata is still being persisted.
    firstData.catch(()=>{});
    videoStopped=new Promise(resolve=>{currentRecorder.onstop=resolve;});
    videoDetach=()=>{
      acceptData=false;
      currentRecorder.ondataavailable=currentRecorder.onerror=currentRecorder.onstop=currentRecorder.onstart=null;
    };
    currentRecorder.onstart=()=>{videoClock=performance.now();};
    currentRecorder.ondataavailable=e=>{
      if(!acceptData || !e.data.size)return;
      const sequence=videoChunks++,blob=e.data,savedMs=videoElapsed();
      videoWrites=videoWrites.then(async()=>{
        if(videoWriteError)return; // No later chunks may bridge a gap in durable storage.
        await mediaCommit('chunks',{id:`${videoId}:${sequence}`,projectId:state.id,videoId,sequence,blob},m=>{
          const v=m.videos.find(x=>x.id===videoId);v.chunks=sequence+1;v.bytes+=blob.size;v.savedMs=savedMs;
        });
        activeVideo=clone(method().videos.find(v=>v.id===videoId));resolveData();
      }).catch(e=>{
        videoWriteError=videoError=e;rejectData(e);
        try{if(currentRecorder.state!=='inactive')currentRecorder.stop();}catch{}
      });
    };
    currentRecorder.onerror=e=>{
      videoError=e.error||new Error('Ошибка записи видео');rejectData(videoError);
      // stopPass/stopVideo consume any final data, including after an async error.
    };
    method().videos.push(clone(activeVideo));method().revision++;await persist();
    try{currentRecorder.start(1000);videoDidStart=true;}
    catch(e){videoError=e;throw e;}
    videoFlushTimer=setInterval(()=>{
      if(currentRecorder.state==='recording'){
        try{currentRecorder.requestData();}catch(e){videoError=e;rejectData(e);}
      }
    },1000);
    try{await support.deadline(firstData,8000,'Кодек не выдаёт данные видео. Запись остановлена; попробуйте открыть камеру снова.');}
    catch(e){videoError=e;throw e;}
    if(videoError)throw videoError;
  }
  async function togglePause(){
    if(!recorder || recorder.state==='inactive')return;
    if(recorder.state==='recording'){
      videoAccumulated=videoElapsed();videoClock=0;recorder.requestData();recorder.pause();
      $('counter').textContent=`ПАУЗА ${duration(videoAccumulated)}`;
      $('retakeBtn').textContent='Продолжить видео';message('Видео на паузе. Продолжение в этом окне останется в том же файле.');
    }else{
      recorder.resume();videoClock=performance.now();$('retakeBtn').textContent='Пауза видео';message('Запись продолжается.');
    }
  }
  async function advanceVideoGuide(source){
    if(!targets[current] || recorder?.state!=='recording')return;
    guideDwell=0;const m=method();
    m.guideEvents.push({index:current,time:now(),videoId:activeVideo.id,elapsedMs:videoElapsed(),source,angles:orientation()});
    m.currentFrame=++current;state.currentFrame=current;await persist();render();
  }
  async function stopVideo(){
    if(!recorder)return;
    clearInterval(videoFlushTimer);videoFlushTimer=null;
    const id=activeVideo.id;
    videoAccumulated=videoElapsed();videoClock=0;
    try{
      if(recorder.state!=='inactive')recorder.stop();
      if(videoDidStart)await support.deadline(videoStopped,5000,'Кодек не завершил запись. Сохранённые части оставлены для скачивания.');
    }catch(e){videoError=videoError||e;}
    videoDetach?.();await videoWrites;
    const v=method().videos.find(v=>v.id===id);
    if(!v.chunks){
      videoError=videoError||new Error('Видео не выдало ни одного сохранённого фрагмента.');
      method().videos=method().videos.filter(v=>v.id!==id); // This attempt has no originals to preserve.
    }else{
      v.status=videoError?'interrupted':'saved';v.endedAt=now();v.durationMs=videoAccumulated;
      v.guideEnd=current;v.error=videoError?.message||null;
    }
    const failure=videoError;
    recorder=null;activeVideo=null;videoStopped=null;videoDetach=null;videoDidStart=false;
    method().revision++;await persist();
    if(failure)throw failure;
  }
  async function stopPass(finished){
    if(stopping)return;stopping=true;started=false;
    $('modeCaptureBtn').disabled=true;$('finishStationBtn').disabled=true;
    let failure=null;
    try{
      // A photo already requested must commit before the camera is released.
      while(shooting)await new Promise(resolve=>setTimeout(resolve,30));
      if(recorder)await stopVideo();
      retakeIndex=null;mirror();method().finished=finished || (state.activeMethod!=='C' && method().shots.filter(Boolean).length===targets.length);
      await persist();
    }catch(e){failure=e;}
    await releaseCamera();await openStation();stopping=false;
    $('modeCaptureBtn').disabled=false;$('finishStationBtn').disabled=false;
    if(failure)throw failure;
    message('Исходники сохранены на устройстве. Можно скачать набор или продолжить.');
  }
  $('modeCaptureBtn').onclick=safely(()=>stopPass(false));
  $('finishStationBtn').onclick=()=>{
    if(shooting || stopping)return;
    $('finishStationTitle').textContent=`Завершить способ ${state.activeMethod}?`;
    $('finishStationText').textContent=`${summary(state.activeMethod)}. Это завершение прохода, а не проверка полноты сферы. Сохранённый материал останется доступен.`;
    $('finishAnywayBtn').textContent='СОХРАНИТЬ И К СЛЕДУЮЩЕМУ СПОСОБУ';
    $('finishStationModal').classList.add('active');
  };
  $('finishAnywayBtn').onclick=safely(async()=>{
    $('finishStationModal').classList.remove('active');
    const completed=state.activeMethod;
    await stopPass(true);
    const next=completed==='A'?'B':completed==='B'?'C':null;
    if(next){state.activeMethod=next;mirror();await persist();await openStation();message(`${completed} сохранён. Следующий — ${METHODS[next].title}. Оставайтесь на той же точке.`);}
    else message('Три способа доступны ниже. Скачайте каждый набор отдельно; полноту сферы проверим при сшивке.');
  });
  async function exportSet(key){
    if(downloadBusy)return;
    downloadBusy=true;renderExports();message(`Готовлю ${key}: исходники без уменьшения…`);
    try{
      await writes;const m=clone(state.methods[key]),folder=METHODS[key].folder;
      const parts=[];let zipError=null;
      const finished=new Promise((resolve,reject)=>{
        const zip=new fflate.Zip((err,data,final)=>{if(err){zipError=err;reject(err);return;}parts.push(data);if(final)resolve();});
        // Producers are asynchronous, ZIP entries use STORE (no re-encoding/compression).
        (async()=>{
          async function add(name,blobs){
            if(zipError)throw zipError;
            const entry=new fflate.ZipPassThrough(`${folder}/${name}`);zip.add(entry);
            for await(const blob of blobs){
              if(!blob)throw new Error(`Не найден исходник ${name}`);
              for(let offset=0;offset<blob.size;offset+=4*1024*1024){
                entry.push(new Uint8Array(await blob.slice(offset,offset+4*1024*1024).arrayBuffer()),false);
              }
            }
            entry.push(new Uint8Array(),true);
          }
          let bytes=0;
          for(const shot of m.shots.filter(Boolean)){const file=await read('files',shot.id);bytes+=shot.bytes;await add(shot.filename,[file?.blob]);}
          for(const v of m.videos){
            bytes+=v.bytes;
            if(!v.chunks)continue;
            async function* chunks(){for(let i=0;i<v.chunks;i++)yield (await read('chunks',`${v.id}:${i}`))?.blob;}
            await add(v.filename,chunks());
          }
          const manifest={schema:1,app:'LUNARU Capture',version:VERSION,exportedAt:now(),
            objectId:state.id,objectName:state.objectName,station:'S01',stationName:state.stationName,
            captureMethod:key,dataset:folder,location:state.gps,placeMode:state.mode,
            plannedTargets:METHODS[key].grid,sphereCoverage:'not_validated',
            camera:m.camera,photoSource:m.photoSource||null,photoRequest:m.photoRequest||null,orientationModel:m.orientationModel||'legacy-013',
            frames:m.shots.filter(Boolean),videos:m.videos,guideEvents:m.guideEvents,
            passFinished:m.finished,totalSourceBytes:bytes,
            notes:['No resize or video transcoding during export.',
              'Video-frame JPEG is explicitly distinguished from ImageCapture photo.',
              'Device orientation is approximate; raw alpha/beta/gamma are retained.',
              'Interrupted recordings may contain only persisted chunks; test playback.',
              'Completing the guide does not establish full spherical coverage.']};
          await add('capture.json',[new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'})]);
          await add('README.txt',[new Blob([`${folder}\nОбъект: ${state.objectName}\nОдна физическая точка: S01\n\n${METHODS[key].help}\n\nПараметры каждого файла — capture.json. Фото не уменьшены при экспорте. Видео — исходные файлы; после перезапуска продолжение находится в отдельном файле. Кадры из видео не извлекались.\nЗавершение прохода не означает, что сфера покрыта полностью. Сшивка и проверка выполняются отдельно.\n`])]);
          zip.end();
        })().catch(e=>{zip.terminate();reject(e);});
      });
      await finished;
      const blob=new Blob(parts,{type:'application/zip'}),url=URL.createObjectURL(blob);urls.add(url);
      const slug=state.objectName.replace(/[^\p{L}\p{N}._-]+/gu,'_').slice(0,64)||'LUNARU';
      const filename=`${slug}_${folder}.zip`;
      const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
      state.methods[key].download={time:now(),filename,bytes:blob.size,revision:m.revision,confirmed:false};await persist();
      message(`${key}: скачивание передано браузеру. Откройте «Загрузки» и проверьте ZIP. Локальные исходники сохранены.`);
      // Leave enough time for Android's download manager to consume the URL.
      setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},300000);
    }finally{downloadBusy=false;renderExports();}
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden && recorder?.state==='recording')togglePause().catch(report);
  });
  window.addEventListener('pagehide',()=>{
    // Best effort only: the UI exposes the confirmed durable duration separately.
    if(recorder && recorder.state!=='inactive'){
      videoAccumulated=videoElapsed();videoClock=0;recorder.stop();
    }
  });
  window.addEventListener('beforeunload',e=>{
    if(recorder || shooting){e.preventDefault();e.returnValue='';}
  });
  async function boot(){
    $('newBtn').disabled=true;
    if(navigator.locks){
      await new Promise((resolve,reject)=>{
        navigator.locks.request('lunaru-capture-abc-tab',{ifAvailable:true},lock=>{
          if(!lock){reject(new Error('LUNARU A/B/C уже открыта в другой вкладке. Закройте её и обновите эту страницу.'));return;}
          resolve();return new Promise(()=>{}); // Released by the browser when this document closes.
        }).catch(reject);
      });
    }
    db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open(DATABASE,1);
      req.onupgradeneeded=()=>{for(const name of ['projects','files','chunks'])req.result.createObjectStore(name,{keyPath:'id'});};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
      req.onblocked=()=>reject(new Error('Закройте другую вкладку LUNARU и обновите страницу.'));
    });
    db.onversionchange=()=>db.close();
    // Recovery changes metadata only; it never removes media or invents missing chunks.
    for(const p of await all('projects')){
      let changed=false;
      for(const v of p.methods.C.videos)if(v.status==='recording'){v.status='interrupted';changed=true;}
      if(changed)await transaction(['projects'],tx=>tx.objectStore('projects').put(p));
    }
    $('newBtn').disabled=false;await refreshHome();message('Готово. Используйте одну вкладку LUNARU для съёмки.');
  }
  boot().catch(e=>{$('bootStatus').textContent='Хранилище недоступно — съёмка не начата. Откройте обычную вкладку Chrome, проверьте свободное место.';report(e);});
})();
