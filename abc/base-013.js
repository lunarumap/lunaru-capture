
"use strict";
const DB_NAME='lunaru_capture_media_v1';
const DB_STORE='frames';
function openMediaDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(DB_STORE)){
        db.createObjectStore(DB_STORE,{keyPath:'id'});
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function storeFrameBlob(blob,frameNo){
  const db=await openMediaDb();
  const tx=db.transaction(DB_STORE,'readwrite');
  const store=tx.objectStore(DB_STORE);
  const id=`${state.objectName}__S${pad(state.station)}__${pad(frameNo)}`;
  store.put({
    id,
    objectName:state.objectName,
    station:state.station,
    frame:frameNo,
    blob,
    savedAt:new Date().toISOString()
  });
  await new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  });
  db.close();
}
function checkVisualOrientation(){
  const notice=$('orientationNotice');
  if(!notice) return;
  // Only show the notice when the browser is genuinely wide/landscape.
  const landscape=window.innerWidth>window.innerHeight;
  notice.style.display=landscape?'grid':'none';
}
window.addEventListener('resize',checkVisualOrientation);
window.addEventListener('orientationchange',()=>setTimeout(checkVisualOrientation,150));

let geoCandidate=null,geoCandidateCount=0,geoPromptDismissed=false;
function setCoordPill(txt,good=false){
  const el=$('gpsPill'); if(!el) return;
  el.textContent=txt;
  el.style.borderColor=good?'#3e8c67':'#5b4b3f';
  el.style.color=good?'#9af0bd':'#ffd5ad';
}
function maybeOfferCoordinates(p){
  if(!state || state.mode==='outdoor-gps' || geoPromptDismissed) return;
  const acc=Math.round(p.coords.accuracy||9999);
  if(acc>35) return;
  geoCandidate={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,time:new Date().toISOString()};
  geoCandidateCount++;
  if(geoCandidateCount<2) return;
  $('geoPromptText').textContent=`📍 Координаты появились · ±${acc} м`;
  $('geoPrompt').style.display='block';
}
const $=id=>document.getElementById(id),KEY='lunaru_capture_v013';let stream=null,started=false,current=0,shots=[],lastAngles=null,stableSince=0,autoLock=false,selectedMode=null,state=null,baseYaw=null;const targets=[];
for(let i=0;i<12;i++)targets.push({yawOffset:i*30,pitch:0,label:'Горизонт'});
for(let i=0;i<8;i++)targets.push({yawOffset:i*45,pitch:45,label:'Верхний ряд'});
for(let i=0;i<8;i++)targets.push({yawOffset:i*45,pitch:-45,label:'Нижний ряд'});
targets.push({pitch:82,label:'Потолок 1',verticalOnly:true},{pitch:82,label:'Потолок 2',verticalOnly:true},{pitch:-82,label:'Пол 1',verticalOnly:true},{pitch:-82,label:'Пол 2',verticalOnly:true});
function show(id){document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active'));$(id).classList.add('active')}function save(){if(state)localStorage.setItem(KEY,JSON.stringify(state))}function load(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){return null}}function pad(n){return String(n).padStart(2,'0')}
function autoObjectName(){
  const d=new Date();
  return `Объект_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}function norm(v){v%=360;if(v<0)v+=360;return v}function diff(a,b){let d=norm(a)-norm(b);if(d>180)d-=360;if(d<-180)d+=360;return d}function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function refreshHome(){const s=load();if(s&&!s.objectFinished){$('resumeWrap').style.display='block';$('resumeText').textContent=`${s.objectName} · Станция ${pad(s.station)} · ${s.currentFrame}/${targets.length} кадров`}else $('resumeWrap').style.display='none'}refreshHome();
document.querySelectorAll('.modebtn').forEach(b=>b.onclick=()=>{selectedMode=b.dataset.mode;document.querySelectorAll('.modebtn').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');$('createBtn').disabled=!selectedMode});$('objectName').oninput=()=>{$('createBtn').disabled=!selectedMode};$('newBtn').onclick=()=>show('newObject');$('backBtn').onclick=()=>show('home');
$('createBtn').onclick=()=>{
if(state && !state.objectFinished && $('createBtn').textContent==='СОХРАНИТЬ РЕЖИМ'){
  state.objectName=$('objectName').value.trim()||state.objectName||autoObjectName();
  state.mode=selectedMode; state.gps=null; save();
  $('createBtn').textContent='НАЧАТЬ ОБЪЕКТ';
  openStation(); $('startStationBtn').textContent=(state.currentFrame||0)>0?'ПРОДОЛЖИТЬ СЪЁМКУ':'НАЧАТЬ СЪЁМКУ'; return;
}
state={objectName:$('objectName').value.trim()||autoObjectName(),mode:selectedMode,station:1,stationName:'',currentFrame:0,shots:[],completedStations:[],objectFinished:false,gps:null,createdAt:new Date().toISOString()};save();openStation()
};$('resumeBtn').onclick=()=>{state=load();state.completedStations=state.completedStations||[];state.stationName=state.stationName||'';current=state.currentFrame||0;shots=state.shots||[];openStation()};

let gpsWatchId=null;
function stopGpsWatch(){
  if(gpsWatchId!==null && navigator.geolocation){
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId=null;
  }
}
function startGpsWatch(){
  stopGpsWatch();
  geoCandidate=null; geoCandidateCount=0; geoPromptDismissed=false;
  if(!navigator.geolocation){
    setCoordPill('Координаты нет',false);
    return;
  }
  if(state.mode==='outdoor-gps') setCoordPill('Координаты: поиск…',false);
  else if(state.mode==='indoor') setCoordPill('Помещение',true);
  else setCoordPill('Без координат',true);

  gpsWatchId=navigator.geolocation.watchPosition(
    p=>{
      const acc=Math.round(p.coords.accuracy||9999);
      if(state.mode==='outdoor-gps'){
        state.gps={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,time:new Date().toISOString()};
        save();
        setCoordPill(`Координаты ✓ ±${acc} м`,true);
      }else{
        maybeOfferCoordinates(p);
      }
    },
    ()=>{
      if(state.mode==='outdoor-gps') setCoordPill('Координаты нет',false);
    },
    {enableHighAccuracy:true,maximumAge:3000,timeout:7000}
  );
}

function openStation(){
  $('stationTitle').textContent=`Станция ${pad(state.station)}`;
  $('startStationBtn').textContent=(state.currentFrame||0)>0?'ПРОДОЛЖИТЬ СЪЁМКУ':'НАЧАТЬ СЪЁМКУ';
  $('stationObject').textContent=state.objectName;
  $('stationName').value=state.stationName||'';
  const modeNames={'outdoor-gps':'Улица · GPS','outdoor-no-gps':'Улица · без GPS','indoor':'Помещение'};
  $('stationMode').textContent=modeNames[state.mode]||'';
  show('stationStart');
  if(state.mode==='outdoor-gps'){
    $('gpsLine').textContent='Координаты: определяю…';
    if(navigator.geolocation)navigator.geolocation.getCurrentPosition(p=>{
      state.gps={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,time:new Date().toISOString()};save();
      $('gpsLine').textContent=`Координаты получены · точность ±${Math.round(p.coords.accuracy)} м`;
    },()=>{$('gpsLine').textContent='Координаты недоступны · можно снимать без них'},{enableHighAccuracy:true,timeout:7000,maximumAge:0});
  }else if(state.mode==='outdoor-no-gps') $('gpsLine').textContent='Без координат · станцию можно поставить на карту позже';
  else $('gpsLine').textContent='Помещение · координаты не требуются';
}
$('stationName').addEventListener('input',()=>{if(state){state.stationName=$('stationName').value.trim();save();}});

async function tryPortraitLock(){
  try{
    if(screen.orientation && typeof screen.orientation.lock==='function'){
      await screen.orientation.lock('portrait');
    }
  }catch(e){}
}

async function orientPermission(){try{if(typeof DeviceOrientationEvent!=="undefined"&&typeof DeviceOrientationEvent.requestPermission==="function")return(await DeviceOrientationEvent.requestPermission())==='granted';return true}catch(e){return false}}
$('changeModeBtn').onclick=()=>{
  selectedMode=state.mode;
  $('objectName').value=state.objectName||'';
  document.querySelectorAll('.modebtn').forEach(x=>x.classList.toggle('sel',x.dataset.mode===selectedMode));
  $('createBtn').disabled=false;
  $('createBtn').textContent='СОХРАНИТЬ РЕЖИМ';
  show('newObject');
};

function compatSummary(){
  const secure=window.isSecureContext===true;
  const media=!!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);
  const proto=location.protocol;
  const motion=('DeviceOrientationEvent' in window);
  const bits=[
    `Камера API ${media?'✓':'✕'}`,
    `Датчики ${motion?'✓':'✕'}`,
    `Контекст ${secure?'✓':'✕'}`,
    proto==='file:'?'локальный файл':'веб'
  ];
  if($('compatLine')) $('compatLine').textContent=bits.join(' · ');
  return {secure,media,proto,motion};
}
async function openCameraRedmiSafe(){
  if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)){
    throw new Error('Camera API недоступен в этом режиме Chrome');
  }
  let firstErr=null;
  try{
    return await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'}},audio:false
    });
  }catch(e){
    firstErr=e;
  }
  try{
    // Второй проход специально максимально простой для бюджетных Android.
    return await navigator.mediaDevices.getUserMedia({video:true,audio:false});
  }catch(e2){
    const err=new Error(e2?.message||firstErr?.message||'Permission denied');
    err.name=e2?.name||firstErr?.name||'CameraError';
    err.firstError=firstErr?.name||'';
    throw err;
  }
}
function explainCameraError(e){
  const name=e?.name||'';
  const msg=e?.message||String(e||'');
  if(name==='NotAllowedError'||/permission|denied/i.test(msg)){
    if(location.protocol==='file:'){
      return 'Chrome запретил камеру для локального HTML. Разрешения Android включены, но file:// всё равно блокируется. Нужен запуск LUNARU Capture по HTTPS.';
    }
    return 'Доступ к камере запрещён браузером. Разрешите камеру для этого сайта.';
  }
  if(name==='NotFoundError') return 'Камера не найдена.';
  if(name==='NotReadableError') return 'Камера занята другим приложением или системой.';
  if(name==='OverconstrainedError') return 'Эта камера не поддерживает запрошенный режим.';
  return `Камера не открылась: ${name?name+': ':''}${msg}`;
}

$('startStationBtn').onclick=async()=>{
  state.stationName=$('stationName').value.trim();save();
  compatSummary();
  $('status').textContent='Открываю камеру…';
  await tryPortraitLock();
  await orientPermission();
  try{
    stream=await openCameraRedmiSafe();
    $('video').srcObject=stream;
    await $('video').play();
    current=state.currentFrame||0;
    shots=state.shots||[];
    baseYaw=Number.isFinite(state.baseYaw)?state.baseYaw:null;
    started=true;
    document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active'));
    $('captureUi').classList.add('active');
    $('actions').classList.add('active');
    $('objectPill').textContent=state.objectName;
    $('stationPill').textContent=`Станция ${pad(state.station)}`;
    startGpsWatch();checkVisualOrientation();render();
    $('status').textContent='Камера открыта ✓';
  }catch(e){
    started=false;
    $('status').textContent=explainCameraError(e);
    if($('compatLine')){
      const c=compatSummary();
      $('compatLine').textContent += ` · ошибка ${e?.name||'CameraError'}`;
      if(c.proto==='file:') $('compatLine').style.color='#ffbd73';
    }
  }
};
function render(){
  $('counter').textContent=`${current} / ${targets.length}`;
  const t=targets[current];
  if(!t){
    $('guideMain').textContent='Станция готова ✓';
    $('guideSub').textContent='Нажмите «Завершить станцию»';
    $('directionArrow').textContent='✓';
    $('target').classList.add('good');
    return;
  }
  $('target').classList.remove('good');
  $('directionArrow').textContent='';
  if(t.verticalOnly){
    $('guideMain').textContent=t.pitch>0?'Направьте телефон вверх':'Направьте телефон вниз';
    $('guideSub').textContent=`${t.label} · азимут не важен`;
  }else if(baseYaw===null){
    $('guideMain').textContent='Держите телефон вертикально';
    $('guideSub').textContent='Фиксирую первое направление…';
  }else{
    $('guideMain').textContent=t.label;
    $('guideSub').textContent=`Кадр ${current+1} из ${targets.length}`;
  }
  stableSince=0;autoLock=false;
}

function onOrientation(e){
  if(!started||!targets[current])return;
  const yaw=norm(e.webkitCompassHeading ?? (360-(e.alpha||0)));
  const beta=Number.isFinite(e.beta)?e.beta:0;
  const pitch=clamp(beta-90,-90,90);
  lastAngles={yaw,pitch};
  const t=targets[current];

  // Потолок/пол: около зенита азимут нестабилен, поэтому учитываем только наклон.
  if(t.verticalOnly){
    const dp=pitch-t.pitch;
    const pitchOk=Math.abs(dp)<10;
    $('target').classList.toggle('good',pitchOk);
    if(pitchOk){
      $('directionArrow').textContent='✓';
      $('guideMain').textContent='Держите неподвижно…';
      $('guideSub').textContent='Снимаю автоматически';
      if(!stableSince)stableSince=performance.now();
      if(performance.now()-stableSince>700&&!autoLock){autoLock=true;shoot(true);}
    }else{
      stableSince=0;autoLock=false;
      $('directionArrow').textContent=dp<0?'↑':'↓';
      $('guideMain').textContent=t.pitch>0?'Направьте телефон вверх':'Направьте телефон вниз';
      $('guideSub').textContent='Поворачиваться влево/вправо не нужно';
    }
    return;
  }

  // Первое горизонтальное направление станции становится локальным нулём.
  if(baseYaw===null){
    if(Math.abs(pitch)>18){
      $('guideMain').textContent=pitch>0?'Опустите телефон немного':'Поднимите телефон немного';
      $('guideSub').textContent='Сначала держите телефон вертикально';
      $('directionArrow').textContent=pitch>0?'↓':'↑';
      return;
    }
    baseYaw=yaw; state.baseYaw=baseYaw; save();
    $('status').textContent='Начальное направление станции зафиксировано';
  }
  const targetYaw=norm(baseYaw+t.yawOffset);
  const dy=diff(yaw,targetYaw), dp=pitch-t.pitch;
  const yawOk=Math.abs(dy)<7, pitchOk=Math.abs(dp)<7, good=yawOk&&pitchOk;
  $('target').classList.toggle('good',good);
  if(good){
    $('directionArrow').textContent='✓';$('guideMain').textContent='Держите неподвижно…';$('guideSub').textContent='Снимаю автоматически';
    if(!stableSince)stableSince=performance.now();
    if(performance.now()-stableSince>650&&!autoLock){autoLock=true;shoot(true);}return;
  }
  stableSince=0;autoLock=false;
  if(!pitchOk){
    $('directionArrow').textContent=dp<0?'↑':'↓';$('guideMain').textContent=dp<0?'Поднимите телефон':'Опустите телефон';
  }else if(!yawOk){
    $('directionArrow').textContent=dy<0?'→':'←';$('guideMain').textContent=dy<0?'Повернитесь вправо':'Повернитесь влево';
  }
  $('guideSub').textContent=`Кадр ${current+1} из ${targets.length}`;
}

window.addEventListener('deviceorientation',onOrientation,true);
async function shoot(auto){if(!started||!targets[current])return;const v=$('video'),c=$('canvas');c.width=v.videoWidth||1280;c.height=v.videoHeight||720;c.getContext('2d').drawImage(v,0,0,c.width,c.height);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.92));if(!blob)return;shots[current]={index:current+1,time:new Date().toISOString(),target:{...targets[current],yaw:(targets[current].verticalOnly||baseYaw===null)?null:norm(baseYaw+targets[current].yawOffset)},angles:lastAngles,auto};await storeFrameBlob(blob,current+1);$('flash').classList.remove('on');void $('flash').offsetWidth;$('flash').classList.add('on');current++;state.currentFrame=current;state.shots=shots;save();$('status').textContent=`Кадр ${current} сохранён в станции${auto?' автоматически':''}`;render()}
$('retakeBtn').onclick=()=>{
  if(current<=0){$('status').textContent='Ещё нечего переснимать';return}
  current--;shots=shots.slice(0,current);state.currentFrame=current;state.shots=shots;save();
  $('status').textContent=`Переснятие кадра ${current+1}`;render();
};
$('manualBtn').onclick=()=>{if(!started){return}$('status').textContent='Ручной кадр…';shoot(false);};
function stopCaptureToStation(){
  started=false;if(stream)stream.getTracks().forEach(t=>t.stop());stopGpsWatch();
  state.currentFrame=current;state.shots=shots;save();
  $('captureUi').classList.remove('active');$('actions').classList.remove('active');
}
function archiveCurrentStation(reason='completed'){
  state.completedStations=state.completedStations||[];
  const record={station:state.station,name:state.stationName||'',shots:[...shots],gps:state.gps||null,mode:state.mode,baseYaw:state.baseYaw??baseYaw??null,frames:current,totalFrames:targets.length,status:reason,completedAt:new Date().toISOString()};
  const ix=state.completedStations.findIndex(s=>s.station===state.station);
  if(ix>=0)state.completedStations[ix]=record;else state.completedStations.push(record);
}
function goNextStation(reason='completed'){
  archiveCurrentStation(reason);
  state.station=(state.station||1)+1;state.stationName='';state.currentFrame=0;state.shots=[];state.gps=null;state.baseYaw=null;
  current=0;shots=[];baseYaw=null;save();openStation();$('status').textContent=`Станция ${pad(state.station)} готова к съёмке`;
}
$('finishStationBtn').onclick=()=>{
  if(current>=targets.length){stopCaptureToStation();goNextStation('completed');return;}
  const missing=targets.length-current;
  $('finishStationTitle').textContent='Станция ещё не полностью снята';
  $('finishStationText').textContent=`Осталось ${missing} кадр${missing===1?'':missing<5?'а':'ов'}. Можно доснять или сохранить станцию как незавершённую и перейти дальше.`;
  $('finishStationModal').classList.add('active');
};
$('continueStationBtn').onclick=()=>{$('finishStationModal').classList.remove('active');};
$('finishAnywayBtn').onclick=()=>{$('finishStationModal').classList.remove('active');stopCaptureToStation();goNextStation('incomplete');};
$('modeCaptureBtn').onclick=()=>{
  state.currentFrame=current;state.shots=shots;save();stopCaptureToStation();
  selectedMode=state.mode;$('objectName').value=state.objectName||'';
  document.querySelectorAll('.modebtn').forEach(x=>x.classList.toggle('sel',x.dataset.mode===selectedMode));
  $('createBtn').disabled=false;$('createBtn').textContent='СОХРАНИТЬ РЕЖИМ';show('newObject');
};
$('finishObjectBtn').onclick=()=>{
  state.stationName=$('stationName').value.trim();
  if((state.currentFrame||0)>0 || (state.shots||[]).length){
    current=state.currentFrame||0;shots=state.shots||[];archiveCurrentStation(current>=targets.length?'completed':'incomplete');
  }
  state.objectFinished=true;save();show('home');refreshHome();$('status').textContent='Объект завершён';
};

$('geoUseBtn').onclick=()=>{
  if(!geoCandidate) return;
  state.gps=geoCandidate; state.positionMode='gps'; save();
  geoPromptDismissed=true;$('geoPrompt').style.display='none';
  setCoordPill(`Координаты ✓ ±${Math.round(geoCandidate.accuracy)} м`,true);
  $('status').textContent='Координаты сохранены только для этой станции';
};
$('geoIgnoreBtn').onclick=()=>{
  geoPromptDismissed=true;
  $('geoPrompt').style.display='none';
  $('status').textContent='Координаты для этой станции не используются';
};
