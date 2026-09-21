// Browser integration tests. A simulated rear camera is used, never a physical Redmi 9.
// Install playwright, fflate; pass CHROMIUM_PATH for an existing Chromium binary.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {unzipSync,strFromU8}=require(process.env.FFLATE_MODULE || 'fflate');
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:8765/abc/';
const out=process.env.TEST_OUTPUT || '/tmp/lunaru-capture-abc-test';
await fs.mkdir(out,{recursive:true});
let server;
if(!process.env.TEST_BASE_URL){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  server=http.createServer(async (req,res)=>{
    let relative=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(relative.endsWith('/'))relative+='index.html';
    const file=path.resolve(root,'.'+relative);
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    try{const bytes=await fs.readFile(file);res.setHeader('Content-Type',({'html':'text/html','js':'text/javascript','css':'text/css'})[file.split('.').at(-1)] || 'application/octet-stream');res.end(bytes);}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(8765,'127.0.0.1',resolve));
}
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,
  args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:393,height:851},acceptDownloads:true});
await context.addInitScript(()=>{
  // Fake devices have no facingMode. Verify the requested constraint and annotate this mock only.
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.cameraRequests=[];
  navigator.mediaDevices.getUserMedia=async constraints=>{
    window.cameraRequests.push(structuredClone(constraints));
    if(constraints.video.facingMode?.exact!=='environment' && !constraints.video.deviceId?.exact)throw new Error('Rear/pinned camera not requested');
    const s=await original({audio:false,video:{width:640,height:480,frameRate:15}});
    const track=s.getVideoTracks()[0],settings=track.getSettings.bind(track);
    track.getSettings=()=>({...settings(),facingMode:'environment',deviceId:'simulated-rear-camera'});
    return s;
  };
  window.ImageCapture=undefined;
});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('dialog',d=>d.accept());
async function open(){await page.goto(base);await page.locator('#newBtn:enabled').waitFor();}
async function setup(){await page.click('#startStationBtn');await page.locator('#cameraReview.active').waitFor();await page.locator('#confirmCameraBtn:enabled').waitFor();}
async function start(){await setup();await page.click('#confirmCameraBtn');await page.locator('#captureUi.active').waitFor();}
async function photo(){
  const before=await page.evaluate(()=>state.methods[state.activeMethod].revision);
  await page.click('#manualBtn');
  await page.waitForFunction(n=>state.methods[state.activeMethod].revision>n,before);
}
async function stop(){await page.click('#modeCaptureBtn');await page.locator('#stationStart.active').waitFor();}
async function finish(){await page.click('#finishStationBtn');await page.click('#finishAnywayBtn');await page.locator('#stationStart.active').waitFor();}
async function resume(){await page.locator('#savedObjects button').first().click();await page.locator('#stationStart.active').waitFor();}
async function exportZip(key){
  const promise=page.waitForEvent('download');
  await page.locator(`[data-export="${key}"] button`).first().click();
  const d=await promise;assert.equal(await d.failure(),null);
  const file=path.join(out,d.suggestedFilename());await d.saveAs(file);
  const files=unzipSync(await fs.readFile(file));
  const manifestName=Object.keys(files).find(k=>k.endsWith('/capture.json'));
  return {files,manifest:JSON.parse(strFromU8(files[manifestName])),file};
}
try{
  await open();await page.click('#newBtn');await page.fill('#objectName','Mobile regressions');
  await page.click('[data-mode="indoor"]');await page.click('#createBtn');
  await page.evaluate(()=>{
    const button=document.querySelector('#startStationBtn'), handler=button.onclick;
    button.onclick=function(...args){window.inClick=true;try{return handler.apply(this,args);}finally{window.inClick=false;}};
    DeviceOrientationEvent.requestPermission=()=>{window.permissionInClick=!!window.inClick;return Promise.resolve(window.inClick?'granted':'denied');};
  });
  await start();assert.equal(await page.evaluate(()=>window.permissionInClick),true);
  const poses=await page.evaluate(()=>{
    const p=window.LunaruCaptureSupport.cameraPose;
    return [p({alpha:0,beta:90,gamma:0}),p({alpha:80,beta:90,gamma:-80}),p({alpha:180,beta:-90,gamma:0}),p({alpha:0,beta:-179,gamma:0}),p({alpha:null,beta:90,gamma:0})];
  });
  assert.ok(Math.abs(poses[0].pitch)<.001);
  assert.ok(Math.min(poses[1].yaw,360-poses[1].yaw)<.001,'Euler branch change must preserve optical heading');
  assert.ok(Math.abs(poses[2].pitch)<.001,'Negative beta branch still faces horizon');
  assert.ok(poses[3].pitch>88,'Crossing zenith must not turn upper target into nadir');
  assert.equal(poses[4],null);
  for(const height of [851,660,595]){
    await page.setViewportSize({width:375,height});
    const boxes=await page.evaluate(()=>{
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,center:r.top+r.height/2};};
      return {aim:rect('target'),video:rect('video'),info:rect('captureDetails')};
    });
    assert.ok(Math.abs(boxes.aim.center-boxes.video.center)<1,'Reticle must center on video');
    assert.ok(boxes.info.bottom<=boxes.aim.top,'Camera metadata must not obscure reticle');
  }
  await page.setViewportSize({width:393,height:851});
  await page.evaluate(async()=>{
    baseYaw=state.baseYaw=state.methods.A.baseYaw=0;
    for(let i=0;i<15;i++){
      dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:360-(i%2?8:6),beta:90,gamma:0}));
      await new Promise(r=>setTimeout(r,80));
    }
  });
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),1,'Boundary jitter must allow one stable shot without advancing twice');
  await page.evaluate(async()=>{
    // Do not shoot just because a fast turn sweeps through the next target.
    for(let yaw=10;yaw<=50;yaw+=2){
      dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:360-yaw,beta:90,gamma:0}));
      await new Promise(r=>setTimeout(r,25));
    }
  });
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),1);
  await page.waitForTimeout(400);
  await page.evaluate(async()=>{
    baseYaw=state.baseYaw=state.methods.A.baseYaw=329; // next target = 359°
    for(let i=0;i<15;i++){
      const yaw=[358,359,0,1][i%4];
      dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:360-yaw,beta:90,gamma:0}));
      await new Promise(r=>setTimeout(r,80));
    }
  });
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),2,'North wrap must not reverse the guidance or skip a photo');
  await stop();await page.click('#finishObjectBtn');await page.reload();await page.locator('#newBtn:enabled').waitFor();
  await page.click('#newBtn');await page.fill('#objectName','Redmi 9 bench');
  await page.click('[data-mode="indoor"]');await page.click('#createBtn');
  await setup();assert.match(await page.textContent('#photoInfo'),/не полноразмерное/);
  assert.match(await page.textContent('#cameraInfo'),/640 × 480/);
  assert.equal(await page.evaluate(()=>cameraRequests[0].video.width.ideal),3840);
  await page.click('#confirmCameraBtn');
  for(let i=0;i<3;i++)await photo();
  await page.evaluate(()=>{state.version='0.14.0';save();});
  await stop();await page.reload();await page.locator('#newBtn:enabled').waitFor();await resume();
  assert.equal(await page.evaluate(()=>state.version),'0.14.0');
  assert.match(await page.textContent('[data-method="A"]'),/3\/32/);
  await start();for(let i=3;i<32;i++)await photo();
  assert.match(await page.textContent('#guideSub'),/Полнота сферы ещё не проверена/);
  await page.click('#retakeBtn');await photo();
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),32);
  await finish();assert.equal(await page.evaluate(()=>state.activeMethod),'B');
  await start();for(let i=0;i<40;i++)await photo();await finish();
  assert.equal(await page.evaluate(()=>state.activeMethod),'C');
  await setup();assert.match(await page.textContent('#photoInfo'),/4K не получено/);
  await page.click('#confirmCameraBtn');await page.waitForTimeout(2400);
  await page.click('#retakeBtn');const paused=await page.textContent('#counter');
  await page.waitForTimeout(1100);assert.equal(await page.textContent('#counter'),paused);
  await page.click('#retakeBtn');await page.click('#manualBtn');await page.waitForTimeout(2100);
  await stop();await page.reload();await page.locator('#newBtn:enabled').waitFor();await resume();
  assert.equal(await page.evaluate(()=>state.methods.C.videos[0].status),'saved');
  assert.ok(await page.evaluate(()=>state.methods.C.videos[0].chunks>0));
  await start();await page.waitForTimeout(1500);await finish();
  const A=await exportZip('A'),B=await exportZip('B'),C=await exportZip('C');
  assert.equal(A.manifest.frames.length,32);assert.equal(B.manifest.frames.length,40);
  assert.equal(C.manifest.videos.length,2);
  assert.equal(A.manifest.objectId,C.manifest.objectId);
  assert.equal(C.manifest.sphereCoverage,'not_validated');
  for(const result of [A,B])for(const f of result.manifest.frames){
    assert.equal(f.width,640);assert.equal(f.height,480);assert.equal(f.source,'video-frame');
    assert.equal(result.files[`${result.manifest.dataset}/${f.filename}`].length,f.bytes);
    assert.equal(f.angles,null);assert.ok(f.time);
  }
  assert.deepEqual(A.manifest.plannedTargets.slice(0,12).map(t=>t.pitch),Array(12).fill(0));
  assert.deepEqual(B.manifest.plannedTargets.slice(0,6).map(t=>t.pitch),[45,0,-45,-45,0,45]);
  // Original video can be decoded after durable recovery and ZIP export.
  for(const v of C.manifest.videos){
    const bytes=C.files[`${C.manifest.dataset}/${v.filename}`];assert.equal(bytes.length,v.bytes);
    await fs.writeFile(path.join(out,v.filename),bytes);
    const decoded=await page.evaluate(async ({data,type})=>{
      const video=document.createElement('video'),url=URL.createObjectURL(new Blob([new Uint8Array(data)],{type}));
      video.muted=true;video.src=url;
      await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('Exported video did not decode'));});
      const size=[video.videoWidth,video.videoHeight];URL.revokeObjectURL(url);return size;
    },{data:[...bytes],type:v.mimeType});
    assert.deepEqual(decoded,[640,480]);
  }
  assert.match(await page.textContent('[data-export="C"]'),/передано браузеру/);
  await page.screenshot({path:path.join(out,'methods.png'),fullPage:true});

  // Storage failure must not increment the counter or erase the existing originals.
  await page.click('[data-method="B"]');await start();await page.click('#retakeBtn');
  await page.evaluate(()=>{
    window.originalPut=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){
      if(this.name==='files')throw new DOMException('Test quota exhausted','QuotaExceededError');
      return window.originalPut.apply(this,args);
    };
  });
  const before=await page.evaluate(()=>state.methods.B.revision);
  await page.click('#manualBtn');await page.locator('#stationStart.active').waitFor();
  assert.equal(await page.evaluate(()=>state.methods.B.revision),before);
  assert.match(await page.textContent('#status'),/quota exhausted/);
  await page.evaluate(()=>{IDBObjectStore.prototype.put=window.originalPut;});

  // A native photo's real dimensions are used, not the requested/preview dimensions.
  await page.evaluate(()=>{
    window.ImageCapture=class {
      async getPhotoCapabilities(){return {imageWidth:{max:2000},imageHeight:{max:1500}};}
      async takePhoto(){
        const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=1600;
        return new Promise(r=>canvas.toBlob(r,'image/jpeg'));
      }
    };
  });
  await start();await page.click('#retakeBtn');await photo();await stop();
  assert.deepEqual(await page.evaluate(()=>{const f=state.methods.B.shots.at(-1);return [f.width,f.height,f.source];}),[1200,1600,'image-capture']);
  await page.evaluate(()=>{ImageCapture.prototype.takePhoto=async()=>{throw new Error('Native photo test failure');};});
  await start();await page.click('#retakeBtn');await page.click('#manualBtn');
  await page.locator('#cameraReview.active').waitFor();
  assert.match(await page.textContent('#photoInfo'),/не смогло сделать снимок/);
  await page.click('#confirmCameraBtn');await photo();await stop();
  assert.equal(await page.evaluate(()=>state.methods.B.shots.at(-1).source),'video-frame');

  // Encoder allocation can fail even when isTypeSupported succeeds.
  await page.click('[data-method="C"]');
  await page.evaluate(()=>{
    window.originalRecorder=window.MediaRecorder;
    window.MediaRecorder=class extends window.originalRecorder {
      start(){throw new DOMException('Test encoder unavailable','NotSupportedError');}
    };
  });
  await page.click('#startStationBtn');await page.locator('#startStationBtn:enabled').waitFor();
  await page.locator('#stationStart.active').waitFor();
  assert.equal(await page.evaluate(()=>state.methods.C.videos.length),2);
  assert.match(await page.textContent('#status'),/encoder unavailable/);
  await page.evaluate(()=>{window.MediaRecorder=window.originalRecorder;});

  // Same asynchronous encoder error shown on Redmi, with no stop event.
  // The probe must reject it and validate the lower mode on the SAME device.
  await page.evaluate(()=>{
    window.probeAttempts=0;window.probeOptions=[];
    window.MediaRecorder=class extends window.originalRecorder {
      constructor(stream,opts){super(stream,opts);window.probeOptions.push(opts);this.fail=++window.probeAttempts===1;}
      start(...args){
        if(!this.fail)return super.start(...args);
        setTimeout(()=>this.onerror?.({error:new Error('The given encoder configuration is not supported by the encoder.')}),50);
      }
    };
  });
  await setup();
  assert.ok(await page.evaluate(()=>window.probeAttempts>=2));
  assert.match(await page.textContent('#photoInfo'),/записано и воспроизведено/);
  assert.ok(await page.evaluate(()=>window.probeOptions.every(o=>!JSON.stringify(o).includes('42E01E') && !o.videoBitsPerSecond)));
  await page.click('#confirmCameraBtn');await page.locator('#captureUi.active').waitFor();await page.waitForTimeout(1500);await stop();
  assert.equal(await page.evaluate(()=>state.methods.C.videos.at(-1).status),'saved');
  assert.ok(await page.evaluate(()=>state.methods.C.videos.at(-1).camera.recordingAttempts[0].error.includes('encoder configuration')));
  await page.locator('[data-export="C"] button').filter({hasText:'▶'}).last().click();
  await page.locator('#videoReview.active').waitFor();
  await page.evaluate(()=>{const v=document.querySelector('#savedVideo');v.muted=true;return v.play();});
  await page.waitForFunction(()=>document.querySelector('#savedVideo').currentTime>.2);
  await page.waitForFunction(()=>document.querySelector('#playbackStatus').textContent.includes('воспроизводится'));
  await page.click('#closeVideoReviewBtn');
  await page.evaluate(()=>{window.MediaRecorder=window.originalRecorder;});
  const slowProbe=await page.evaluate(async()=>{
    const c=document.createElement('canvas');c.width=160;c.height=120;
    const ctx=c.getContext('2d');let tick=0;
    const timer=setInterval(()=>{ctx.fillStyle=++tick%2?'red':'blue';ctx.fillRect(0,0,160,120);},100);
    const s=c.captureStream(3);
    try{return await window.LunaruCaptureSupport.probe(s,{});}
    finally{clearInterval(timer);s.getTracks().forEach(t=>t.stop());}
  });
  assert.ok(slowProbe.measuredFps<6,'Probe must measure slow encoded frames, not requested camera FPS');

  // An encoder can fail on the real start, even after a good probe. No permanent
  // busy state or empty saved clip; bounded stop even if no stop event is delivered.
  await setup();
  const videosBefore=await page.evaluate(()=>state.methods.C.videos.length);
  await page.evaluate(()=>{
    window.MediaRecorder=class {
      constructor(){this.state='inactive';this.mimeType='video/mp4';}
      start(){this.state='recording';this.onstart?.();setTimeout(()=>{
        this.state='inactive';this.onerror?.({error:new Error('Async start failure without stop event')});
      },50);}
      stop(){} requestData(){}
    };
  });
  await page.click('#confirmCameraBtn');await page.locator('#stationStart.active').waitFor({timeout:12000});
  assert.equal(await page.evaluate(()=>state.methods.C.videos.length),videosBefore);
  assert.equal(await page.locator('#startStationBtn').isEnabled(),true);
  assert.match(await page.textContent('#status'),/Async start failure/);
  await page.evaluate(()=>{window.MediaRecorder=window.originalRecorder;});

  // Reload during recording: preserve every already committed chunk; never call it complete.
  await page.click('[data-method="C"]');await start();await page.waitForTimeout(3200);
  const durable=await page.evaluate(()=>structuredClone(state.methods.C.videos.at(-1)));
  assert.ok(durable.chunks>0,'At least one video chunk must reach durable storage before reload');
  await page.reload();await page.locator('#newBtn:enabled').waitFor();await resume();
  const recovered=await page.evaluate(()=>structuredClone(state.methods.C.videos.at(-1)));
  assert.equal(recovered.id,durable.id);assert.ok(recovered.chunks>=durable.chunks);
  assert.equal(recovered.status,'interrupted');
  const second=await context.newPage();await second.goto(base);
  await second.waitForFunction(()=>document.querySelector('#status').textContent.includes('другой вкладке'));
  assert.equal(await second.locator('#newBtn').isDisabled(),true);await second.close();
  assert.deepEqual(errors,[]);
  const report={passed:true,browser:browser.version(),camera:'simulated rear 640×480; no real phone',
    checks:['A 32 frames and retake','B 40-frame zigzag','C real MediaRecorder pause/resume and two original video files',
      'reload recovery','three ZIPs, original media sizes and metadata','exported video decoding',
      'quota failure does not advance','native photo actual dimensions','native failure needs explicit fallback confirmation',
      'reload during recording preserves committed chunks and marks interruption','second tab cannot overwrite active data',
      'encoder start failure leaves no empty successful clip or stalled recorder',
      'iOS permission requested in click stack', 'jitter allows stable auto photo; fast turn does not; 359/0 wrap',
      'async encoder error selects and decodes fallback without changing device',
      'saved video plays in app', 'real start error without stop event recovers without empty clip',
      'rear optical axis handles Euler branch and zenith', 'reticle layout at 375px and three screen heights',
      'real 3fps encoded probe is measured as slow'],
    artifacts:[A.file,B.file,C.file]};
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(e){
  console.error('PAGE STATUS:',await page.textContent('#status'));
  console.error('PAGE ERRORS:',errors);
  await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});
  throw e;
}finally{await browser.close();server?.close();}
