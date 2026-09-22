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
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:8789/abc/';
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
  await new Promise(resolve=>server.listen(8789,'127.0.0.1',resolve));
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
 await open();await page.click('#newBtn');await page.fill('#objectName','Cleanup isolated');await page.click('[data-mode="indoor"]');await page.click('#createBtn');await start();await photo();await stop();await page.click('#finishObjectBtn');
 await page.evaluate(()=>localStorage.setItem('unrelated-cleanup-sentinel','preserve'));
 const readCounts=()=>page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('lunaru_capture_abc_v014',1);r.onsuccess=()=>resolve(r.result);});const counts=[];for(const name of ['projects','files','chunks'])counts.push(await new Promise(resolve=>{const r=db.transaction(name).objectStore(name).count();r.onsuccess=()=>resolve(r.result);}));db.close();return counts;});
 const before=await readCounts();assert.equal(before[0],1);assert.equal(before[1],1);
 page.removeAllListeners('dialog');
 const cancelled=new Promise(resolve=>page.once('dialog',async d=>{await d.dismiss();resolve();}));await page.click('#clearSessionsBtn');await cancelled;await page.locator('#clearSessionsBtn:enabled').waitFor();assert.deepEqual(await readCounts(),before);
 await page.evaluate(()=>{window.origClear=IDBObjectStore.prototype.clear;IDBObjectStore.prototype.clear=function(){if(this.name==='files')throw new Error('Injected cleanup failure');return window.origClear.call(this);};});
 page.once('dialog',d=>d.accept());await page.click('#clearSessionsBtn');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Injected cleanup failure'));assert.deepEqual(await readCounts(),before,'Failed clear rolls back projects as well');
 await page.evaluate(()=>{IDBObjectStore.prototype.clear=window.origClear;});
 page.once('dialog',d=>d.accept());await page.click('#clearSessionsBtn');await page.waitForFunction(()=>document.querySelector('#clearSessionsBtn').disabled&&document.querySelectorAll('#savedObjects .savedObject').length===0);assert.deepEqual(await readCounts(),[0,0,0]);assert.equal(await page.evaluate(()=>localStorage.getItem('unrelated-cleanup-sentinel')),'preserve');
 await page.click('#newBtn');await page.fill('#objectName','After cleanup');await page.click('[data-mode="indoor"]');await page.click('#createBtn');await start();await photo();await stop();assert.equal(await page.evaluate(()=>state.methods.A.shots.length),1);assert.deepEqual(errors,[]);
 console.log('PASS cleanup 0.19: cancel preserves records; injected failure rolls back; all stores empty after confirmation; unrelated storage retained; new photo saved after clear');
}finally{await browser.close();server?.close();}
