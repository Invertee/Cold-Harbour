import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createApplication} from '../server/app.js';
import {encryptBackup,decryptBackup,validateBackupData} from '../server/backups.js';
import {validateRoom} from '../server/validate.js';
import {signedMessage} from '../server/modules/boiler.js';

const password='correct horse harbour battery';
function remove(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('cold-backup-'));rmSync(target,{recursive:true,force:true});}
async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'cold-backup-'));
  let app=createApplication({dataDir:directory,haRequest:async()=>[],haRegistryRequest:async()=>[]});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();remove(directory);});
  return {directory,get app(){return app;},async restart(){await app.close();app=createApplication({dataDir:directory});},
    async post(path,body,headers={}){
      const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/backups/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1',...headers},body:JSON.stringify(body)});
      return {status:response.status,body:await response.json(),headers:response.headers};
    }};
}
const snapshot=store=>({config:store.config(),rooms:store.list('rooms'),rules:store.list('rules'),haToken:store.secret('haToken'),boilerKey:store.secret('boilerKey')});

test('encrypted backup moves configuration and credentials between independent instances and survives restart',async t=>{
  const source=await fixture(t),target=await fixture(t),store=source.app.context.store,destination=target.app.context.store;
  store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test',powerEntity:'sensor.house_power'});
  store.save('energy',{...store.config().energy,gasToday:'sensor.gas_consumption'});
  store.save('notifications',{enabled:true,targets:['service:notify.mobile_app_phone','entity:notify.display']});
  store.save('general',{mode:'listen',timezone:'America/New_York'});store.secret('haToken','private-source-token');
  const pairing=source.app.context.boiler.pair();
  store.save('heatingPlan',{...store.config().heatingPlan,houseTarget:22});store.save('thermostat',{mode:'active'});
  const room=validateRoom({...store.list('rooms')[0],name:'Source lounge',sensorEntities:['sensor.lounge'],sensorFreshnessMinutes:120,radiatorEntity:'climate.lounge'});
  store.put('rooms',{...room,radiatorMode:'focus'});
  destination.secret('haToken','old-destination-token');destination.secret('boilerKey','old-destination-pair');
  destination.db.prepare('INSERT INTO readings VALUES (?,?,?)').run('existing','2026-10-26T00:00:00Z',12);
  assert.notDeepEqual(readFileSync(join(source.directory,'secrets.key')),readFileSync(join(target.directory,'secrets.key')));
  const exported=await source.post('export',{password});assert.equal(exported.status,200);assert.equal(exported.headers.get('cache-control'),'no-store');
  assert.doesNotMatch(JSON.stringify(exported.body),/private-source-token|Source lounge|old-destination-token/);
  const before=snapshot(destination),preview=await target.post('preview',{backup:exported.body,password});assert.equal(preview.status,200);
  assert.equal(preview.body.credentials.haToken,true);assert.equal(preview.body.credentials.boilerKey,true);assert.doesNotMatch(JSON.stringify(preview.body),/private-source-token/);
  assert.deepEqual(snapshot(destination),before);
  const restored=await target.post('import',{backup:exported.body,password,previewId:preview.body.previewId,confirm:true});assert.equal(restored.status,200);
  const expected={...store.config(),thermostat:{mode:'planning'}};assert.deepEqual(destination.config(),expected);
  assert.equal(destination.secret('haToken'),'private-source-token');assert.equal(destination.secret('boilerKey'),pairing.key);assert.equal(destination.list('rooms')[0].radiatorMode,'monitor');assert.equal(destination.list('rooms')[0].name,'Source lounge');
  assert.deepEqual(destination.list('rooms'),store.list('rooms').map(room=>({...validateRoom(room),radiatorMode:'monitor'})));
  assert.deepEqual(destination.list('rules'),store.list('rules'));assert.equal(destination.db.prepare('SELECT count(*) AS n FROM readings').get().n,1);
  assert.deepEqual(target.app.context.ha.states,[]);assert.equal(target.app.context.ha.status.connected,false);
  const message={v:1,device_id:pairing.deviceId,boot_id:'a'.repeat(32),request_id:'b'.repeat(16),sequence:1,mode:'Cold Harbour',telemetry:{flow_c:40}};
  const reply=JSON.parse(target.app.context.boiler.exchange(signedMessage(message,pairing.key)).payload);assert.equal(reply.authority,'pid');assert.equal(reply.lease_s,0);
  const replay=await target.post('import',{backup:exported.body,password,previewId:preview.body.previewId,confirm:true});assert.equal(replay.status,409);
  await target.restart();assert.deepEqual(target.app.context.store.config(),expected);assert.equal(target.app.context.store.secret('boilerKey'),pairing.key);assert.equal(target.app.context.store.secret('haToken'),'private-source-token');
});

test('invalid passwords, tampering, invalid schemas, stale previews and unprotected requests leave configuration intact',async t=>{
  const target=await fixture(t),store=target.app.context.store,original=snapshot(store);
  const exported=await target.post('export',{password});assert.equal(exported.status,200);const backup=exported.body;
  assert.equal((await target.post('export',{password:'short'})).status,400);
  assert.equal((await target.post('export',{password},{'X-MODS-Request':'0'})).status,403);
  assert.equal((await target.post('preview',{backup,password},{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await target.post('preview',{backup,password:'different password'})).status,400);
  assert.equal((await target.post('preview',{backup:{...backup,version:999},password})).status,400);
  const tampered=structuredClone(backup);tampered.data=(tampered.data[0]==='A'?'B':'A')+tampered.data.slice(1);
  assert.equal((await target.post('preview',{backup:tampered,password})).status,400);
  assert.equal((await target.post('import',{backup,password,confirm:true})).status,400);
  const data=await decryptBackup(backup,password);
  for(const mutate of [
    d=>{d.config.general.timezone='Invalid/Clock';},
    d=>{d.rooms.push(structuredClone(d.rooms[0]));},
    d=>{d.rooms[0].radiatorEntity='climate.shared';d.rooms[1].radiatorEntity='climate.shared';},
    d=>{d.rules[0].roomId='nonexistent';},
    d=>{d.secrets.extra='unexpected';},
    d=>{d.config.heatingPlan.activities[0].rooms.living={offset:0,priority:'invalid'};},
    d=>{d.config.homeAssistant.url='http://user:password@ha.test';},
    d=>{d.config.thermostat.mode='auto';},
  ]){
    const invalid=structuredClone(data);mutate(invalid);
    const response=await target.post('preview',{backup:await encryptBackup(invalid,password),password});assert.equal(response.status,400,JSON.stringify(response.body));
  }
  assert.deepEqual(snapshot(store),original);
  const preview=await target.post('preview',{backup,password});store.save('general',{...store.config().general,timezone:'Europe/Paris'});
  const changed=snapshot(store),response=await target.post('import',{backup,password,previewId:preview.body.previewId,confirm:true});assert.equal(response.status,409);assert.deepEqual(snapshot(store),changed);
});

test('restore rolls back all replacements if a database write fails, and absent credentials replace existing ones',async t=>{
  const target=await fixture(t),store=target.app.context.store;
  const backup=(await target.post('export',{password})).body;
  store.secret('haToken','destination-secret');store.secret('boilerKey','destination-pair');store.save('general',{mode:'listen',timezone:'Europe/Paris'});
  const original=snapshot(store),preview=(await target.post('preview',{backup,password})).body;
  store.db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON rooms BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  const failure=await target.post('import',{backup,password,previewId:preview.previewId,confirm:true});assert.equal(failure.status,500);assert.deepEqual(snapshot(store),original);
  store.db.exec('DROP TRIGGER fail_restore;');
  const restored=await target.post('import',{backup,password,previewId:preview.previewId,confirm:true});assert.equal(restored.status,200);assert.equal(store.secret('haToken'),'');assert.equal(store.secret('boilerKey'),'');
});

test('expired previews and a different valid backup require a fresh review',async t=>{
  const target=await fixture(t),store=target.app.context.store,original=snapshot(store);
  const backup=(await target.post('export',{password})).body,preview=(await target.post('preview',{backup,password})).body;
  const replacement=await encryptBackup(await decryptBackup(backup,password),password);
  assert.equal((await target.post('import',{backup:replacement,password,previewId:preview.previewId,confirm:true})).status,409);
  const realNow=Date.now();t.mock.method(Date,'now',()=>realNow+11*60000);
  assert.equal((await target.post('import',{backup,password,previewId:preview.previewId,confirm:true})).status,409);
  assert.deepEqual(snapshot(store),original);
});

test('configuration backups larger than the normal request limit can be previewed and imported',async t=>{
  const target=await fixture(t),store=target.app.context.store;
  for(let i=0;i<200;i++)store.put('rooms',validateRoom({...store.list('rooms')[0],id:`extra-${i}`,name:`Extra room ${i}`,sensorEntities:[`sensor.extra_${i}`]}));
  const backup=(await target.post('export',{password})).body;assert.ok(JSON.stringify(backup).length>65536);
  const preview=await target.post('preview',{backup,password});assert.equal(preview.status,200);assert.equal(preview.body.rooms,204);
  assert.equal((await target.post('import',{backup,password,previewId:preview.body.previewId,confirm:true})).status,200);
  const data=await decryptBackup(backup,password);assert.equal(validateBackupData(data).rooms.length,204);
});
