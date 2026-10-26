import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createApplication} from '../server/app.js';
import {createStore} from '../server/db.js';
import {createNotifications,notificationDevices} from '../server/integrations/notifications.js';
import {HttpError} from '../server/http.js';
import {validateConfig} from '../server/validate.js';
import {validateBackupData} from '../server/backups.js';
import {notificationContent} from '../public/modules/notifications.js';

const services=[{domain:'notify',services:{notify:{},persistent_notification:{},send_message:{},mobile_app_sam_phone:{name:'Sam’s phone'},mobile_app_tablet:{},'mobile_app_bad/path':{}}},{domain:'switch',services:{turn_on:{}}}];
const states=[{entity_id:'notify.hall_display',state:'unknown',attributes:{friendly_name:'Hall display',supported_features:1}},{entity_id:'notify.kitchen',state:'2026-10-26T10:00:00Z',attributes:{friendly_name:'Kitchen display'}},{entity_id:'notify.offline',state:'unavailable'},{entity_id:'switch.boiler',state:'on'}];
const phone='service:notify.mobile_app_sam_phone',tablet='service:notify.mobile_app_tablet',display='entity:notify.hall_display';
function remove(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('cold-notifications-'));rmSync(target,{recursive:true,force:true});}
async function fixture(t,customRequest){
  const directory=mkdtempSync(join(tmpdir(),'cold-notifications-')),writes=[];
  const app=createApplication({dataDir:directory,haRegistryRequest:async()=>[],haRequest:customRequest || (async(url,options)=>{
    if(options?.method==='POST'){writes.push({url,options,body:JSON.parse(options.body)});return [];}
    return url.endsWith('/api/services')?services:states;
  })});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();remove(directory);});
  const store=app.context.store;
  store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','private-ha-token');
  return {app,store,writes,directory,async request(path,body,headers={}){
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-MODS-Request':'1',...headers},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }};
}

test('notification discovery offers explicit mobile actions and notify entities with availability and title support',()=>{
  const devices=notificationDevices(services,states);
  assert.equal(devices.length,5);
  assert.equal(devices.find(device=>device.id===phone).name,'Sam’s phone');
  assert.equal(devices.find(device=>device.id===tablet).name,'tablet');
  assert.equal(devices.find(device=>device.id===display).available,true); // Unknown means never sent, not unavailable.
  assert.equal(devices.find(device=>device.id==='entity:notify.offline').available,false);
  assert.equal(devices.find(device=>device.id==='entity:notify.kitchen').supportsTitle,false);
  assert.deepEqual(notificationDevices([],states),[]);
});

test('API tests exactly one chosen device, including unsaved devices while notifications are off',async t=>{
  const f=await fixture(t);
  const discovered=await f.request('notifications');assert.equal(discovered.status,200);assert.equal(discovered.body.targets.length,5);assert.equal(f.writes.length,0);
  assert.doesNotMatch(JSON.stringify(discovered.body),/private-ha-token/);
  let response=await f.request('notifications/test',{target:phone});assert.equal(response.status,200);assert.equal(response.body.accepted,true);
  assert.match(response.body.message,/accepted/);assert.match(response.body.message,/confirm delivery/);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].url,'http://ha.test/api/services/notify/mobile_app_sam_phone');
  assert.deepEqual(f.writes[0].body,{title:'Cold Harbour',message:'This is a test notification from Cold Harbour.'});
  assert.equal(f.writes[0].options.headers.Authorization,'Bearer private-ha-token');
  response=await f.request('notifications/test',{target:display,title:'Heating update',message:'Test display'});assert.equal(response.status,200);
  assert.deepEqual(f.writes[1].body,{entity_id:'notify.hall_display',title:'Heating update',message:'Test display'});assert.ok(f.writes[1].url.endsWith('/notify/send_message'));
  await f.request('notifications/test',{target:'entity:notify.kitchen',title:'Unsupported title',message:'Message only'});
  assert.deepEqual(f.writes[2].body,{entity_id:'notify.kitchen',message:'Message only'});
  assert.equal(f.store.config().notifications.enabled,false);assert.deepEqual(f.store.config().notifications.targets,[]);
  assert.doesNotMatch(JSON.stringify(f.store.events()),/Test display|private-ha-token|Message only/);
});

test('send uses saved recipients, reports partial failure and respects the enable setting',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('notifications/send',{message:'House update'})).status,409);assert.equal(f.writes.length,0);
  const targets=[phone,display,'entity:notify.offline','service:notify.mobile_app_removed'];
  assert.equal((await f.request('settings',{section:'notifications',values:{enabled:true,targets}})).status,200);
  const response=await f.request('notifications/send',{message:'House update',target:tablet});
  assert.equal(response.status,200);assert.equal(response.body.accepted,false);
  assert.deepEqual(response.body.results.map(result=>result.accepted),[true,true,false,false]);
  assert.equal(f.writes.length,2);assert.ok(!f.writes.some(write=>write.url.endsWith('/mobile_app_tablet')));
  assert.equal((await f.request('settings')).body.notifications.targets.length,4);
});

test('invalid and unprotected requests never issue service calls or change notification settings',async t=>{
  const f=await fixture(t);
  for(const body of [{},{target:'switch.boiler'},{target:'service:notify.notify'},{target:'service:notify.mobile_app_bad/path'},{target:'service:notify.mobile_app_missing'},{target:'entity:notify.offline'},{target:phone,message:'   '},{target:phone,message:'a'.repeat(2001)},{target:phone,title:'a'.repeat(121)},{target:phone,message:42}]){
    const response=await f.request('notifications/test',body);assert.ok([400,409].includes(response.status),JSON.stringify(response));
  }
  assert.equal((await f.request('notifications/test',{target:phone},{'X-MODS-Request':'0'})).status,403);
  assert.equal((await f.request('notifications/test',{target:phone},{'Sec-Fetch-Site':'cross-site'})).status,403);
  for(const values of [{enabled:'true'},{enabled:true},{targets:[phone,phone]},{targets:['service:notify.notify']},{targets:'all'},{targets:Array(21).fill(phone)},{unexpected:true}])assert.equal((await f.request('settings',{section:'notifications',values})).status,400);
  assert.equal(f.writes.length,0);assert.deepEqual(f.store.config().notifications,{enabled:false,targets:[]});
});

test('connection and provider failures are visible without exposing internal errors',async t=>{
  let failSend=false;
  const f=await fixture(t,async(url,options)=>{
    if(options?.method==='POST')throw new HttpError(502,'Authentication failed. Check your API key or token.');
    if(failSend)throw new Error('internal private-ha-token details');
    return url.endsWith('/api/services')?services:states;
  });
  const response=await f.request('notifications/test',{target:phone});assert.equal(response.status,502);assert.match(response.body.error,/Authentication failed/);
  failSend=true;
  const discovery=await f.request('notifications');assert.equal(discovery.status,200);assert.deepEqual(discovery.body.targets,[]);assert.match(discovery.body.error,/Unable to load/);assert.doesNotMatch(JSON.stringify(discovery.body),/private-ha-token/);
  f.store.secret('haToken','');
  assert.equal((await f.request('notifications')).body.configured,false);
  assert.equal((await f.request('notifications/test',{target:phone})).status,409);
});

test('connection changes cancel pending discovery and overlapping sends are rejected',async t=>{
  const f=await fixture(t);let finish,generation=0;const ha={get generation(){return generation;}};
  const notifications=createNotifications(f.store,ha,async(url,options)=>{
    assert.notEqual(options?.method,'POST');
    return url.endsWith('/api/services')?new Promise(resolve=>finish=resolve):states;
  });
  const pending=notifications.test({target:phone});
  await assert.rejects(notifications.test({target:phone}),error=>error.status===409&&/already/.test(error.message));
  generation++;finish(services);
  await assert.rejects(pending,error=>error.status===409&&/connection changed/.test(error.message));
  // A failed request releases the sending lock.
  const next=notifications.test({target:phone});generation++;finish(services);await assert.rejects(next,error=>error.status===409&&/connection changed/.test(error.message));
});

test('a connection change between recipients prevents remaining writes',async t=>{
  const f=await fixture(t);f.store.save('notifications',{enabled:true,targets:[phone,tablet]});let generation=0,writes=0;
  const notifications=createNotifications(f.store,{get generation(){return generation;}},async(url,options)=>{
    if(options?.method==='POST'){writes++;generation++;return [];}
    return url.endsWith('/api/services')?services:states;
  });
  await assert.rejects(notifications.send({message:'Update'}),error=>error.status===409);assert.equal(writes,1);
});

test('one failed recipient does not prevent later recipients or retry earlier accepted requests',async t=>{
  const f=await fixture(t);f.store.save('notifications',{enabled:true,targets:[phone,tablet,display]});const writes=[];
  const notifications=createNotifications(f.store,{generation:0},async(url,options)=>{
    if(options?.method==='POST'){
      writes.push(url);
      if(url.endsWith('/mobile_app_tablet'))throw new HttpError(502,'The provider returned HTTP 500.');
      return [];
    }
    return url.endsWith('/api/services')?services:states;
  });
  const response=await notifications.send({message:'Update'});
  assert.equal(response.accepted,false);assert.deepEqual(response.results.map(result=>result.accepted),[true,false,true]);
  assert.match(response.results[1].error,/HTTP 500/);assert.equal(writes.length,3);
});

test('Supervisor notifications use the automatic HA connection and token',async t=>{
  const f=await fixture(t),previous=process.env.SUPERVISOR_TOKEN;process.env.SUPERVISOR_TOKEN='private-supervisor-token';
  try{
    const response=await f.request('notifications/test',{target:phone});assert.equal(response.status,200);
    assert.equal(f.writes[0].url,'http://supervisor/core/api/services/notify/mobile_app_sam_phone');
    assert.equal(f.writes[0].options.headers.Authorization,'Bearer private-supervisor-token');
    assert.doesNotMatch(JSON.stringify(response.body),/private-supervisor-token/);
  }finally{if(previous===undefined)delete process.env.SUPERVISOR_TOKEN;else process.env.SUPERVISOR_TOKEN=previous;}
});

test('existing installations gain defaults, saved devices survive restart and older backups remain importable',async t=>{
  const f=await fixture(t),data={appVersion:'0.14.1',exportedAt:new Date().toISOString(),config:f.store.config(),rooms:f.store.list('rooms'),rules:f.store.list('rules'),secrets:{haToken:'',boilerKey:''}};
  delete data.config.notifications;
  assert.deepEqual(validateBackupData(data).config.notifications,{enabled:false,targets:[]});assert.equal(Object.hasOwn(data.config,'notifications'),false);
  f.store.save('notifications',validateConfig('notifications',{enabled:true,targets:[phone]},f.store.config().notifications));
  const reopened=createStore(f.directory);assert.deepEqual(reopened.config().notifications,{enabled:true,targets:[phone]});reopened.close();
  f.store.db.exec("DELETE FROM migrations WHERE version=12; DELETE FROM settings WHERE section='notifications';");
  const upgraded=createStore(f.directory);assert.deepEqual(upgraded.config().notifications,{enabled:false,targets:[]});upgraded.close();
});

test('notification page keeps unavailable saved devices removable, escapes names and disables testing without destinations',()=>{
  const page=notificationContent({enabled:false,targets:[phone]},{targets:[],error:'Connect Home Assistant'});
  assert.match(page,/value="service:notify.mobile_app_sam_phone" checked/);assert.match(page,/name="target" aria-label="Test device" required disabled/);assert.match(page,/type="submit" disabled>Send test message/);
  const populated=notificationContent({enabled:false,targets:[]},{targets:[{id:display,name:'<script>bad</script>',address:'notify.hall_display',available:true,kind:'Notify entity'}],error:null});
  assert.doesNotMatch(populated,/<script>/);assert.match(populated,/&lt;script&gt;/);
});
