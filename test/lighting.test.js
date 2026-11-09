import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createStore} from '../server/db.js';
import {createHomeAssistant} from '../server/integrations/home-assistant.js';
import {createApplication} from '../server/app.js';
import {createLighting,sunReading,lightTarget} from '../server/modules/lighting.js';
import {defaultLighting,daylightKelvin,lightCapabilities} from '../public/lighting-model.js';
import {lightingContent} from '../public/modules/lighting.js';
import {validateConfig} from '../server/validate.js';
import {validateBackupData} from '../server/backups.js';

const group=(entities=['light.lounge'],values={})=>({id:'lounge',name:'Living room',enabled:true,minKelvin:2200,maxKelvin:6500,entities,...values});
const light=(id='light.lounge',values={})=>({entity_id:id,state:'on',attributes:{friendly_name:'Living room lamp',supported_color_modes:['color_temp'],color_mode:'color_temp',min_color_temp_kelvin:2000,max_color_temp_kelvin:6500,color_temp_kelvin:2700,supported_features:32,...values}});
const sun=(elevation=45)=>({entity_id:'sun.sun',state:elevation<0?'below_horizon':'above_horizon',last_updated:new Date().toISOString(),attributes:{elevation,rising:true}});
function remove(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('cold-lighting-'));rmSync(target,{recursive:true,force:true});}
async function fixture(t,{states=[sun(),light()],groups=[group()],enabled=true,request}={}){
  const directory=mkdtempSync(join(tmpdir(),'cold-lighting-')),store=createStore(directory),calls=[];
  store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test-token');
  store.save('lighting',{...structuredClone(defaultLighting),enabled,groups});
  const ha=createHomeAssistant(store,async(url,options)=>{
    if(url.endsWith('/states'))return structuredClone(states);
    const body=JSON.parse(options.body);calls.push({url,body});
    if(request)await request(body,calls.length);
    const entity=states.find(value=>value.entity_id===body.entity_id);
    if(entity){entity.attributes.color_temp_kelvin=body.color_temp_kelvin;entity.attributes.color_mode='color_temp';}
    return [];
  },async()=>[]);
  await ha.poll();const lighting=createLighting({store,ha});
  t.after(async()=>{await lighting.close();store.close();remove(directory);});
  return {store,ha,lighting,states,calls,now:Date.now()};
}

test('daylight curve is bounded, smooth, and warmer at winter sun heights',()=>{
  const range=group();assert.equal(daylightKelvin(range,-90),2200);assert.equal(daylightKelvin(range,-6),2200);assert.equal(daylightKelvin(range,45),6500);assert.equal(daylightKelvin(range,90),6500);
  assert.ok(daylightKelvin(range,15)<daylightKelvin(range,60));
  let previous=2200;for(let elevation=-90;elevation<=90;elevation+=.5){const target=daylightKelvin(range,elevation);assert.ok(target>=previous&&target>=2200&&target<=6500);previous=target;}
  assert.equal(daylightKelvin(group([], {minKelvin:3000,maxKelvin:3000}),20),3000);
});
test('group and device ranges intersect and aggregate HA light entities are excluded',()=>{
  const state=light('light.lounge',{min_color_temp_kelvin:2700,max_color_temp_kelvin:4000});
  assert.equal(lightTarget(state,group(),-18,defaultLighting),2700);assert.equal(lightTarget(state,group(),60,defaultLighting),4000);
  assert.equal(lightTarget(state,group([],{minKelvin:4500,maxKelvin:6000}),60,defaultLighting),null);
  assert.equal(lightCapabilities(light('light.group',{entity_id:['light.on','light.off']})).supported,false);
  assert.equal(lightCapabilities(light('light.rgb',{supported_color_modes:['rgb']})).supported,false);
});
test('native fade sends only Kelvin and a 60 second transition to selected on lights',async t=>{
  const f=await fixture(t,{states:[sun(),light(),{...light('light.off'),state:'off'},light('light.untouched')],groups:[group(['light.lounge','light.off'])]});
  await f.lighting.sync(f.now);assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/\/api\/services\/light\/turn_on$/);
  assert.deepEqual(f.calls[0].body,{entity_id:'light.lounge',color_temp_kelvin:6500,transition:60});
  await f.lighting.sync(f.now+5000);await f.lighting.sync(f.now+60000);assert.equal(f.calls.length,1);
  await f.ha.poll();await f.lighting.sync(f.now+71000);await f.lighting.sync(f.now+76000);assert.equal(f.calls.length,1);
});
test('each group has independent targets and each bulb is clamped to its own capabilities',async t=>{
  const f=await fixture(t,{states:[sun(),light(),light('light.bedroom',{max_color_temp_kelvin:4000})],groups:[group(),group(['light.bedroom'],{id:'bedroom',name:'Bedroom',minKelvin:2000,maxKelvin:4500})]});
  await f.lighting.sync(f.now);assert.deepEqual(f.calls.map(call=>call.body.color_temp_kelvin),[6500,4000]);
  assert.deepEqual(f.lighting.read().groups.map(group=>group.targetKelvin),[6500,4500]);
});
test('newly switched-on lights join daylight and turning off cancels an in-progress adjustment',async t=>{
  const f=await fixture(t,{states:[sun(),{...light(),state:'off'}]});await f.lighting.sync(f.now);assert.equal(f.calls.length,0);
  f.states[1].state='on';await f.ha.poll();await f.lighting.sync(f.now+5000);assert.equal(f.calls.length,1);
  f.states[1].state='off';await f.ha.poll();await f.lighting.sync(f.now+10000);assert.equal(f.lighting.read().groups[0].lights[0].status,'off');
  f.states[1].state='on';f.states[1].attributes.color_temp_kelvin=2200;await f.ha.poll();await f.lighting.sync(f.now+15000);assert.equal(f.calls.length,2);
});
test('lights without native fades interpolate over the whole minute and stop when switched off',async t=>{
  const f=await fixture(t,{states:[sun(),light('light.lounge',{supported_features:0,color_temp_kelvin:2200})]});
  await f.lighting.sync(f.now);assert.equal(f.calls.length,0);
  for(let elapsed=5000;elapsed<=60000;elapsed+=5000){await f.lighting.sync(f.now+elapsed);await f.ha.poll();}
  const values=f.calls.map(call=>call.body.color_temp_kelvin);assert.equal(values.length,12);assert.ok(values[0]>2200&&values[0]<2700);assert.equal(values.at(-1),6500);
  for(let index=1;index<values.length;index++)assert.ok(values[index]>values[index-1]&&values[index]-values[index-1]<=360);
  assert.ok(f.calls.every(call=>!Object.hasOwn(call.body,'transition')&&!Object.hasOwn(call.body,'brightness')));
  f.states[1].attributes.color_temp_kelvin=2200;await f.ha.poll();await f.lighting.sync(f.now+65000);await f.lighting.sync(f.now+70000);
  f.states[1].state='off';await f.ha.poll();const count=f.calls.length;await f.lighting.sync(f.now+75000);assert.equal(f.calls.length,count);
});
test('sunset and changing sun heights update lights after a completed fade',async t=>{
  const f=await fixture(t);await f.lighting.sync(f.now);await f.ha.poll();await f.lighting.sync(f.now+71000);
  f.states[0]=sun(-10);await f.ha.poll();await f.lighting.sync(f.now+76000);assert.equal(f.calls.at(-1).body.color_temp_kelvin,2200);
});
test('offline, missing or stale sun, paused systems and paused groups do not send commands',async t=>{
  const f=await fixture(t,{enabled:false});await f.lighting.sync();assert.equal(f.calls.length,0);
  f.store.save('lighting',{...f.store.config().lighting,enabled:true,groups:[group(['light.lounge'],{enabled:false})]});await f.lighting.sync();assert.equal(f.calls.length,0);
  f.store.save('lighting',{...f.store.config().lighting,groups:[group()]});
  f.states[0].last_updated=new Date(Date.now()-16*60000).toISOString();await f.ha.poll();assert.equal(sunReading(f.ha).ready,false);await f.lighting.sync();assert.equal(f.calls.length,0);
  for(const value of [null,'20',NaN,91]){f.states[0]=sun(value);await f.ha.poll();await f.lighting.sync();assert.equal(f.calls.length,0);}
  f.ha.invalidate();await f.lighting.sync();assert.equal(f.calls.length,0);
});
test('unsupported lights, missing starting temperatures and incompatible ranges remain untouched',async t=>{
  const f=await fixture(t,{states:[sun(),light('light.lounge',{supported_features:0,color_temp_kelvin:null}),light('light.rgb',{supported_color_modes:['rgb']}),light('light.group',{entity_id:['light.on','light.off']})],groups:[group(['light.lounge','light.rgb','light.group'])]});
  await f.lighting.sync();assert.equal(f.calls.length,0);assert.equal(f.lighting.read().groups[0].lights[0].status,'temperature_unavailable');
  f.states[1]=light('light.lounge',{min_color_temp_kelvin:2000,max_color_temp_kelvin:3000});await f.ha.poll();
  f.store.save('lighting',{...f.store.config().lighting,groups:[group(['light.lounge'],{minKelvin:4000,maxKelvin:6500})]});await f.lighting.sync();assert.equal(f.calls.length,0);
  assert.equal(f.lighting.read().groups[0].lights[0].status,'range_unavailable');
});
test('errors retry after a minute while other lights continue and overlapping syncs coalesce',async t=>{
  const f=await fixture(t,{states:[sun(),light(),light('light.other')],groups:[group(['light.lounge','light.other'])],request:async body=>{if(body.entity_id==='light.lounge')throw new Error('Offline bulb');}});
  await Promise.all([f.lighting.sync(f.now),f.lighting.sync(f.now)]);assert.equal(f.calls.length,2);
  assert.equal(f.lighting.read().groups[0].lights[0].status,'error');
  await f.lighting.sync(f.now+5000);assert.equal(f.calls.length,2);await f.lighting.sync(f.now+60001);assert.equal(f.calls.length,3);
});
test('a settings change or connection change cancels queued commands',async t=>{
  let release,started;const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{states:[sun(),light(),light('light.other')],groups:[group(['light.lounge','light.other'])],request:async()=>{started();await gate;}});
  const sync=f.lighting.sync();await began;f.store.save('lighting',{...f.store.config().lighting,enabled:false});release();await sync;assert.equal(f.calls.length,1);
  await assert.rejects(f.ha.applyLightTemperature('light.other',4000,60,()=>true),/settings changed/);
  f.store.save('lighting',{...f.store.config().lighting,enabled:true});f.ha.invalidate();await f.lighting.sync();assert.equal(f.calls.length,1);
});
test('small drift is ignored but a light outside group limits is always corrected',async t=>{
  const f=await fixture(t,{states:[sun(-10),light('light.lounge',{color_temp_kelvin:2160})]});await f.lighting.sync();assert.equal(f.calls[0].body.color_temp_kelvin,2200);
  f.lighting.reset();f.states[1].attributes.color_temp_kelvin=2240;await f.ha.poll();await f.lighting.sync();assert.equal(f.calls.length,1);
});
test('lighting validation rejects overlapping membership, invalid ranges, and arbitrary entities',()=>{
  const validate=values=>validateConfig('lighting',values,structuredClone(defaultLighting));
  const valid=validate({enabled:true,groups:[group()]});assert.equal(valid.groups[0].name,'Living room');
  for(const values of [{enabled:'yes'},{transitionSeconds:1},{warmElevation:1},{coolElevation:0},{groups:[group([])]},{groups:[group(['switch.lamp'])]},{groups:[group(['light.lounge','light.lounge'])]},{groups:[group(),group(['light.lounge'],{id:'other'})]},{groups:[group(['light.lounge'],{minKelvin:7000,maxKelvin:6500})]},{groups:[group(['light.lounge'],{brightness:100})]}])assert.throws(()=>validate(values),{status:400});
});
test('lighting settings survive reopening and older backups acquire a disabled lighting configuration',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'cold-lighting-'));let store=createStore(directory);
  try{
    const settings={...structuredClone(defaultLighting),groups:[group()]};store.save('lighting',settings);store.close();store=createStore(directory);assert.deepEqual(store.config().lighting,settings);
    const data={appVersion:'0.18.0',exportedAt:new Date().toISOString(),config:store.config(),rooms:[],rules:[],secrets:{haToken:'',boilerKey:''}};
    assert.deepEqual(validateBackupData(data).config.lighting,settings);delete data.config.lighting;assert.deepEqual(validateBackupData(data).config.lighting,defaultLighting);
  }finally{store.close();remove(directory);}
});
test('Lighting API is registered, validates settings, protects writes and never controls on GET',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'cold-lighting-')),app=createApplication({dataDir:directory,haRequest:async()=>[],haRegistryRequest:async()=>[]});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();remove(directory);});
  const url=`http://127.0.0.1:${app.server.address().port}/api/`,post=(body,header='1')=>fetch(url+'settings',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':header},body:JSON.stringify(body)});
  const response=await fetch(url+'lighting');assert.equal(response.status,200);const data=await response.json();assert.equal(data.settings.enabled,false);assert.deepEqual(data.groups,[]);
  assert.equal((await (await fetch(url+'modules')).json()).some(module=>module.id==='lighting'),true);
  assert.equal((await post({section:'lighting',values:{groups:[group()]}})).status,200);
  assert.equal((await post({section:'lighting',values:{enabled:true}},'0')).status,403);
  assert.equal((await post({section:'lighting',values:{groups:[group(['light.lounge','light.lounge'])]}})).status,400);
  assert.equal((await (await fetch(url+'lighting')).json()).groups.length,1);
});
test('lighting page renders real states, explicit empty and unavailable states, and escapes entity names',async t=>{
  const f=await fixture(t);let data=f.lighting.read();data.groups[0].name='<script>bad()</script>';data.groups[0].lights[0].name='<img src=x>';
  const html=lightingContent(data);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/60-second transitions/);assert.match(html,/6,500 K/);
  data={...data,groups:[],connected:false,sun:{ready:false,elevation:null,reason:'Connect Home Assistant'}};
  assert.match(lightingContent(data),/Create your first group/);assert.match(lightingContent(data),/#settings\/connections/);
});

test('application tick starts daylight control without waiting for a slow light', {timeout:5000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'cold-lighting-'));let release,started=false;
  const gate=new Promise(resolve=>release=resolve),states=[sun(),light()];
  const app=createApplication({dataDir:directory,haRegistryRequest:async()=>[],haRequest:async(url)=>{
    if(url.endsWith('/states'))return states;
    started=true;await gate;return [];
  }});
  t.after(async()=>{release();await app.close();remove(directory);});
  const {store}=app.context;store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test-token');
  store.save('lighting',{...structuredClone(defaultLighting),enabled:true,groups:[group()]});
  await app.tick();assert.equal(started,true);assert.equal(app.context.lighting.read().groups[0].lights[0].status,'adjusting');release();await app.context.lighting.sync();
});
