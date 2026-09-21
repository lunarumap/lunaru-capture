// Read-only deployed asset comparison plus camera smoke in isolated browser storage.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(import.meta.dirname,'..');
const base=process.env.TEST_BASE_URL||'https://lunarumap.github.io/lunaru-capture/abc/';
const args=['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'];
// Optional specific enterprise CA pins; never globally disable certificate checks.
if(process.env.TEST_CA_DIR){
  const pins=[];
  for(const file of await fs.readdir(process.env.TEST_CA_DIR)){
    if(!file.endsWith('.crt'))continue;
    const cert=new crypto.X509Certificate(await fs.readFile(path.join(process.env.TEST_CA_DIR,file)));
    pins.push(crypto.createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64'));
  }
  if(pins.length)args.push('--ignore-certificate-errors-spki-list='+pins.join(','));
}
let proxy;
if(process.env.HTTPS_PROXY){const u=new URL(process.env.HTTPS_PROXY);proxy={server:u.origin,username:decodeURIComponent(u.username),password:decodeURIComponent(u.password)};}
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args,proxy});
try{
  const context=await browser.newContext({viewport:{width:393,height:851}});
  await context.addInitScript(()=>{
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async()=>{
      const s=await original({audio:false,video:{width:640,height:480,frameRate:15}});
      const t=s.getVideoTracks()[0],get=t.getSettings.bind(t);
      t.getSettings=()=>({...get(),facingMode:'environment',deviceId:'simulated-rear'});return s;
    };window.ImageCapture=undefined;
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'?v=0.16.0');await page.locator('#newBtn:enabled').waitFor();
  assert.match(await page.textContent('header'),/TEST 0.16/);
  for(const file of ['index.html','abc.js','abc.css','capture-support.js']){
    const remote=await page.evaluate(async f=>{const r=await fetch(f+'?v=0.16.0',{cache:'reload'});if(!r.ok)throw Error('HTTP '+r.status);return await r.text();},file);
    assert.equal(remote,await fs.readFile(path.join(root,'abc',file),'utf8'),file+' must match tested source');
  }
  await page.click('#newBtn');await page.fill('#objectName','HTTPS smoke 0.16');
  await page.click('[data-mode="indoor"]');await page.click('#createBtn');
  await page.click('[data-method="C"]');await page.click('#startStationBtn');
  await page.locator('#cameraReview.active').waitFor();await page.locator('#confirmCameraBtn:enabled').waitFor();
  await page.click('#confirmCameraBtn');await page.locator('#captureUi.active').waitFor();
  await page.waitForTimeout(1800);await page.click('#modeCaptureBtn');await page.locator('#stationStart.active').waitFor();
  await page.reload();await page.locator('#newBtn:enabled').waitFor();await page.locator('#savedObjects button').first().click();
  await page.locator('[data-export="C"] button').filter({hasText:'▶'}).last().click();
  await page.locator('#videoReview.active').waitFor();
  await page.evaluate(()=>{const v=document.querySelector('#savedVideo');v.muted=true;return v.play();});
  await page.waitForFunction(()=>document.querySelector('#savedVideo').currentTime>.2);
  assert.deepEqual(errors,[]);
  console.log('PASS: HTTPS TEST 0.16 exact assets; real simulated-camera recording, reload and saved playback; no page errors. Physical phones not tested.');
}finally{await browser.close();}
