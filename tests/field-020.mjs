// Regressions reproduced from TEST 0.19 field files. Simulated camera, not physical phones.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {unzipSync,strFromU8}=require(process.env.FFLATE_MODULE||'fflate');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.TEST_OUTPUT||'/tmp/lunaru-field-020';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{
  const rel=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+rel+(rel.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(await fs.readFile(file));}
  catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(8788,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const context=await browser.newContext({viewport:{width:393,height:851},acceptDownloads:true});
await context.addInitScript(()=>{
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async c=>{
    window.lastCameraRequest=c;
    const s=await gum({audio:false,video:{width:640,height:480,frameRate:15}});
    const t=s.getVideoTracks()[0],settings=t.getSettings.bind(t);
    t.getSettings=()=>({...settings(),deviceId:'field-rear',facingMode:'environment'});return s;
  };
  window.ImageCapture=undefined;
  DeviceOrientationEvent.requestPermission=async()=> 'granted';
});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
async function start(){await page.click('#startStationBtn');await page.locator('#confirmCameraBtn:enabled').waitFor();await page.click('#confirmCameraBtn');await page.locator('#captureUi.active').waitFor();}
async function stop(){await page.click('#modeCaptureBtn');await page.locator('#stationStart.active').waitFor();}
async function photo(){const n=await page.evaluate(()=>state.methods[state.activeMethod].revision);await page.click('#manualBtn');await page.waitForFunction(n=>state.methods[state.activeMethod].revision>n,n);}
async function recover(){await page.click('#retryPhotoBtn');await page.locator('#captureIssue[hidden]').waitFor({state:'attached'});}
async function downloadA(){const d=page.waitForEvent('download');await page.locator('[data-export="A"] button').first().click();const file=await d;const target=path.join(out,file.suggestedFilename());await file.saveAs(target);return fs.readFile(target);}
try{
  await page.goto('http://127.0.0.1:8788/abc/');await page.locator('#newBtn:enabled').waitFor();
  await page.click('#newBtn');await page.fill('#objectName','Field failure');await page.click('[data-mode="indoor"]');await page.click('#createBtn');await start();await photo();
  const identity=await page.evaluate(()=>({id:state.id,shot:state.methods.A.shots[0].id}));
  await page.evaluate(()=>{
    window.realDraw=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(source,...args){
      window.realDraw.call(this,source,...args);
      if(source===document.querySelector('#video')){this.fillStyle='#000';this.fillRect(0,0,this.canvas.width,this.canvas.height);}
    };
  });
  await page.click('#manualBtn');await page.locator('#captureIssue:not([hidden])').waitFor();
  assert.match(await page.textContent('#captureIssueText'),/чёрный кадр/);
  assert.equal(await page.evaluate(()=>started),true,'Black frame must keep the capture session open');
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),1,'Black frame must not be counted');
  await page.screenshot({path:path.join(out,'camera-recovery.png')});
  await page.evaluate(()=>{CanvasRenderingContext2D.prototype.drawImage=window.realDraw;});
  await recover();await photo();
  assert.equal(await page.evaluate(()=>state.id),identity.id);
  assert.equal(await page.evaluate(()=>state.methods.A.shots[0].id),identity.shot);
  assert.equal(await page.evaluate(()=>document.querySelector('#canvas').width),1,'Release the full-resolution canvas backing store');
  // A camera can become muted while JPEG encoding is pending, even though dimensions remain valid.
  await page.evaluate(()=>{
    window.realToBlob=HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob=function(...args){
      if(this.id==='canvas')Object.defineProperty(stream.getVideoTracks()[0],'muted',{configurable:true,get:()=>true});
      return window.realToBlob.apply(this,args);
    };
  });
  await page.click('#manualBtn');await page.locator('#captureIssue:not([hidden])').waitFor();
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),2);
  await page.evaluate(()=>{HTMLCanvasElement.prototype.toBlob=window.realToBlob;delete stream.getVideoTracks()[0].muted;});
  await recover();
  // Renaming while the camera is open must not trigger an automatic photo or change original IDs.
  await page.click('#objectPill');await page.fill('#editObjectName','Renamed project');await page.fill('#editStationName','Kitchen');
  await page.evaluate(()=>dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:300,beta:90,gamma:0})));
  assert.equal(await page.evaluate(()=>state.methods.A.shots.length),2);
  await page.click('#saveNamesBtn');await page.locator('#namesModal.active').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.objectName),'Renamed project');await photo();await stop();
  // Chrome can advertise canShare=true yet deny the actual ZIP transfer. Preserve that exact ZIP.
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
    Object.defineProperty(navigator,'share',{configurable:true,value:async({files})=>{window.deniedFile=files[0];throw new DOMException('Permission denied','NotAllowedError');}});
  });
  await page.click('[data-method="A"]');await page.click('[data-share="A"]');
  await page.waitForFunction(()=>document.querySelector('[data-share="A"]').textContent.startsWith('Поделиться'));
  await page.click('[data-share="A"]');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('не разрешил передачу'));
  assert.equal(await page.locator('[data-share="A"]').count(),0,'Do not ask for an endless denied share retry');
  assert.match(await page.textContent('[data-export="A"] button'),/Скачать готовый ZIP/);
  const cached=new Uint8Array(await page.evaluate(async()=>[...new Uint8Array(await window.deniedFile.arrayBuffer())]));
  const bytes=await downloadA();assert.deepEqual(new Uint8Array(bytes),cached,'Download the already prepared ZIP byte for byte');
  const files=unzipSync(bytes),manifest=JSON.parse(strFromU8(files[Object.keys(files).find(k=>k.endsWith('capture.json'))]));
  assert.equal(manifest.objectName,'Renamed project');assert.equal(manifest.stationName,'Kitchen');assert.equal(manifest.frames.length,3);
  assert.ok(manifest.diagnostics.some(e=>e.name==='BlackFrameError'));assert.ok(manifest.diagnostics.some(e=>e.name==='CameraFrameError'));
  // Both zigzag methods can calibrate from their actual first upper direction.
  await page.click('[data-method="B"]');await start();
  await page.evaluate(()=>dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:80,beta:135,gamma:0})));
  assert.equal(await page.evaluate(()=>baseYaw!==null),true);assert.doesNotMatch(await page.textContent('#guideMain'),/Сначала.*горизонт/);await stop();
  await page.click('[data-method="C"]');await start();
  await page.evaluate(()=>dispatchEvent(new DeviceOrientationEvent('deviceorientation',{alpha:80,beta:135,gamma:0})));
  assert.equal(await page.evaluate(()=>baseYaw!==null),true);assert.match(await page.textContent('#recordingBanner'),/ИДЁТ ЗАПИСЬ ВИДЕО/);
  await page.click('#objectPill');await page.waitForFunction(()=>document.querySelector('#counter').textContent.includes('ПАУЗА'));
  await page.fill('#editStationName','Kitchen renamed during video');await page.click('#saveNamesBtn');
  await page.waitForFunction(()=>document.querySelector('#counter').textContent.includes('REC'));
  await page.click('#manualBtn');await page.waitForTimeout(1200);assert.doesNotMatch(await page.textContent('#guideSub'),/Кадр|Автоснимок/);await page.screenshot({path:path.join(out,'continuous-video.png')});await stop();
  assert.equal(await page.evaluate(()=>state.methods.C.videos[0].status),'saved');
  await page.reload();await page.locator('#newBtn:enabled').waitFor();await page.locator('#savedObjects .alt').first().click();await page.locator('#stationStart.active').waitFor();
  assert.equal(await page.evaluate(()=>state.id),identity.id);assert.equal(await page.evaluate(()=>state.stationName),'Kitchen renamed during video');
  assert.equal(await page.evaluate(()=>state.methods.A.shots[0].id),identity.shot);assert.equal(await page.evaluate(()=>state.methods.A.shots.length),3);
  assert.deepEqual(errors,[]);console.log('PASS: black frames blocked; muted-during-encode blocked; recovery preserves station; backing store released; rename during photo/video and reload; cached denied ZIP download exact; B/C upper start; continuous video saved. Simulated camera only.');
}finally{await browser.close();server.close();}
