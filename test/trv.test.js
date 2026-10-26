import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createStore} from '../server/db.js';
import {createHomeAssistant,temperature} from '../server/integrations/home-assistant.js';
import {createRadiatorControl,radiatorCommand} from '../server/modules/radiators.js';
import {evaluateHeating} from '../server/modules/heating.js';
import {validateRoom} from '../server/validate.js';
import {defaults} from '../server/defaults.js';
import {temperatureSourceOptions} from '../public/temperature-sources.js';
import {radiatorCard,measurementDetails} from '../public/radiators.js';
import {warmupInsights} from '../server/modules/heating-history.js';
import {createApplication} from '../server/app.js';
import {signedMessage} from '../server/modules/boiler.js';
const now=Date.now(),stamp=new Date(now).toISOString();
const climate=(extra={})=>({entity_id:'climate.kitchen',state:'heat',last_reported:stamp,attributes:{friendly_name:'Kitchen TRV',current_temperature:24,temperature:19,temperature_unit:'°C',hvac_modes:['off','heat'],supported_features:1,min_temp:5,max_temp:30,target_temp_step:.5},...extra});
const input=()=>({id:'kitchen',name:'Kitchen',sensorEntities:['sensor.kitchen','climate.kitchen'],radiatorEntity:'climate.kitchen',comfort:20,eco:16,weight:1});
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'cold-trv-')),store=createStore(dir),requests=[],state=climate(),entries=[{entity_id:state.entity_id,platform:'zha',disabled_by:null}];
 store.save('heatingPlan',{...store.config().heatingPlan,version:1});
 store.put('rooms',{...validateRoom(input()),radiatorMode:'monitor'});store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','fixture');
 const ha=createHomeAssistant(store,async(url,options)=>{requests.push({url,options});if(url.endsWith('/states'))return [state];if(url.endsWith('/config'))return {unit_system:{temperature:'°C'}};return [];},async()=>entries);
 const summary=()=>({rooms:store.list('rooms').filter(r=>r.id==='kitchen').map(r=>({...r,fresh:true,target:20.5,targetOffset:0}))}),controller=createRadiatorControl({store,ha},summary);
 t.after(()=>{store.close();const absolute=resolve(dir);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&/^cold-trv-/.test(basename(absolute)));rmSync(absolute,{recursive:true,force:true});});return {store,ha,controller,requests,state,entries,summary};
}
test('TRV measured temperature can be selected and averaged alongside a room sensor',()=>{
 const room=validateRoom(input()),config=structuredClone(defaults);
 const states=[climate(),{entity_id:'sensor.kitchen',state:'20',last_reported:stamp,attributes:{unit_of_measurement:'°C'}}];
 let result=evaluateHeating({rooms:[room],rules:[],states,config,now}).rooms[0];
 assert.equal(result.current,22);assert.equal(result.sensorCountUsed,2);assert.equal(result.radiator.usedInAverage,true);assert.equal(result.radiator.currentTarget,19);assert.equal(result.measurements[1].kind,'thermostat');
 states[0].state='off';assert.equal(evaluateHeating({rooms:[room],rules:[],states,config,now}).rooms[0].current,22);
 states[0].state='unavailable';result=evaluateHeating({rooms:[room],rules:[],states,config,now}).rooms[0];assert.equal(result.current,20);assert.equal(result.sensorCountUsed,1);
 assert.throws(()=>validateRoom({...input(),sensorEntities:['switch.kitchen']}),e=>e.status===400);
 assert.throws(()=>validateRoom({...input(),sensorEntities:['climate.kitchen','climate.kitchen']}),e=>e.status===400);
});
test('TRV temperature uses current_temperature rather than setpoint and validates units, timestamps and values',()=>{
 const state=climate();assert.equal(temperature(state,now,1800000,true),24);
 for(const value of [null,undefined,'',' ',false,'unavailable',NaN,120])assert.equal(temperature({...state,attributes:{...state.attributes,current_temperature:value}},now,1800000,true),null);
 assert.equal(temperature({...state,last_reported:new Date(now-3600000).toISOString()},now,1800000,true),null);
 assert.equal(temperature({...state,last_reported:new Date(now+120000).toISOString()},now,1800000,true),null);
 assert.equal(temperature({...state,attributes:{current_temperature:75.2,temperature_unit:'°F'}},now,1800000,true),24);
 assert.equal(temperature({...state,attributes:{current_temperature:24}},now,1800000,true),null);
 assert.equal(temperature({...state,attributes:{current_temperature:24}},now,1800000,true,'°C'),24);
});
test('sensor picker and room cards distinguish measured temperature, actual target and planned target',()=>{
 const options=temperatureSourceOptions([climate(),{entity_id:'climate.no_measurement',attributes:{temperature:21}},{entity_id:'sensor.power',attributes:{unit_of_measurement:'W'}}]);
 assert.equal(options.length,1);assert.match(options[0][1],/measured temperature/);
 const html=radiatorCard({id:'kitchen',name:'Kitchen',target:20.5,radiator:{name:'Kitchen valve',currentTemperature:24,currentTarget:19,mode:'heat',available:true,usedInAverage:true},radiatorControl:{mode:'monitor',canControl:false,reason:'Monitor only'}});
 assert.match(html,/device target 19.0/);assert.match(html,/planned 20.5/);assert.doesNotMatch(html,/Focus this room|Pause radiator|<select/);assert.match(html,/TRV temperature included/);
 assert.match(measurementDetails({sensorCount:1,sensorCountUsed:1,measurements:[{name:'Kitchen',value:24,kind:'thermostat'}]}),/24.0°C/);
});
test('radiators stay in Monitor and never issue heating services without explicit opt-in',async t=>{
 const f=fixture(t);await f.ha.poll();await f.controller.sync();assert.equal(f.requests.filter(r=>r.options.method==='POST').length,0);assert.equal(f.controller.status('kitchen').mode,'monitor');
});
test('Follow sends only the mapped verified ZHA target, respects device steps and suppresses repeat writes',async t=>{
 const f=fixture(t);await f.ha.poll();await f.controller.setMode('kitchen','follow');
 const posts=f.requests.filter(r=>r.options.method==='POST');assert.equal(posts.length,1);assert.match(posts[0].url,/climate\/set_temperature$/);assert.deepEqual(JSON.parse(posts[0].options.body),{entity_id:'climate.kitchen',temperature:20.5,hvac_mode:'heat'});
 await f.controller.sync(now+30000);assert.equal(f.requests.filter(r=>r.options.method==='POST').length,1);
 f.state.attributes.temperature=20.5;await f.ha.poll();await f.controller.sync(now+360000);assert.equal(f.requests.filter(r=>r.options.method==='POST').length,1);
});
test('Pause uses Off and Monitor releases control without pretending to restore old settings',async t=>{
 const f=fixture(t);await f.ha.poll();await f.controller.setMode('kitchen','pause');
 let posts=f.requests.filter(r=>r.options.method==='POST');assert.deepEqual(JSON.parse(posts[0].options.body),{entity_id:'climate.kitchen',hvac_mode:'off'});
 await f.controller.setMode('kitchen','monitor');await f.controller.sync(now+360000);posts=f.requests.filter(r=>r.options.method==='POST');assert.equal(posts.length,1);
});
test('non-ZHA, disabled, missing and stale registry entries cannot be controlled',async t=>{
 for(const mutate of [f=>f.entries[0].platform='esphome',f=>f.entries[0].disabled_by='user',f=>f.entries.length=0]){
  const f=fixture(t);mutate(f);await f.ha.poll();await assert.rejects(()=>f.controller.setMode('kitchen','focus'),e=>e.status===409);assert.equal(f.requests.filter(r=>r.options.method==='POST').length,0);
 }
 const f=fixture(t);await f.ha.poll();f.store.put('rooms',{...f.store.list('rooms').find(r=>r.id==='kitchen'),radiatorMode:'follow'});await f.controller.sync(now+360000);assert.equal(f.requests.filter(r=>r.options.method==='POST').length,0);
});
test('unknown units, missing room readings and unsupported heat/off modes block commands',()=>{
 const room={...input(),radiatorMode:'follow',fresh:true,target:20.5,targetOffset:0},config=structuredClone(defaults),context={state:climate(),verified:true,fresh:true,temperatureUnit:'°C'};
 config.heatingPlan.version=1;assert.equal(radiatorCommand(room,context,config).command,20.5);
 for(const extra of [{verified:false},{fresh:false},{temperatureUnit:null},{state:climate({attributes:{...climate().attributes,hvac_modes:['auto']}})},{state:climate({attributes:{...climate().attributes,supported_features:0}})}])assert.equal(radiatorCommand(room,{...context,...extra},config).ready,false);
 assert.equal(radiatorCommand({...room,fresh:false},context,config).ready,false);
 assert.equal(radiatorCommand({...room,radiatorMode:'pause'},{...context,state:climate({attributes:{...climate().attributes,hvac_modes:['heat']}})},config).ready,false);
 const focus=radiatorCommand({...room,radiatorMode:'focus',target:16,targetOffset:1},context,config);assert.equal(focus.command,21);
 const fahrenheit=radiatorCommand(room,{...context,temperatureUnit:'°F',state:climate({attributes:{...climate().attributes,min_temp:41,max_temp:86,target_temp_step:1}})},config);assert.equal(fahrenheit.command,69);
});
test('unit discovery handles older climate entities without storing unrelated Home Assistant configuration',async t=>{
 const f=fixture(t);delete f.state.attributes.temperature_unit;await f.ha.poll();assert.equal(f.ha.temperatureUnit,'°C');assert.ok(f.requests.some(r=>r.url.endsWith('/api/config')));f.ha.invalidate();assert.equal(f.ha.temperatureUnit,null);assert.equal(f.ha.radiatorContext('climate.kitchen').verified,false);
});
test('control errors are reported and rate limited instead of retried every poll',async t=>{
 const f=fixture(t);await f.ha.poll();f.ha.applyRadiator=async()=>{throw new Error('private upstream response');};await f.controller.setMode('kitchen','follow');assert.equal(f.controller.status('kitchen').lastError,'Radiator command failed; check Home Assistant.');assert.ok(!JSON.stringify(f.controller.status('kitchen')).includes('private'));
});

test('paused radiators cannot turn solar warming into a radiator warm-up observation',()=>{
 const samples=Array.from({length:41},(_,i)=>({at:new Date(now+i*60000).toISOString(),heating:true,rooms:[{id:'kitchen',current:20+i/20,target:20.5,sourceAt:new Date(now+i*60000).toISOString(),sensorFingerprint:'temperature',radiatorPaused:true}]}));
 assert.equal(warmupInsights(samples,[{id:'kitchen',name:'Kitchen'}])[0].sessions,0);
 samples.forEach(s=>s.rooms[0].radiatorPaused=false);assert.equal(warmupInsights(samples,[{id:'kitchen',name:'Kitchen'}])[0].sessions,1);
});

test('room and radiator APIs opt in separately while signed boiler replies retain PID authority',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-trv-')),requests=[],state=climate();
 const app=createApplication({dataDir:directory,haRequest:async(url,options)=>{requests.push({url,options});return url.endsWith('/states')?[state]:[];},haRegistryRequest:async()=>[{entity_id:'climate.kitchen',platform:'zha',disabled_by:null}]});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&/^cold-trv-/.test(basename(absolute)));rmSync(absolute,{recursive:true,force:true});});
 const {store,boiler}=app.context;store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test');await app.tick();
 app.context.store.save('heatingPlan',{...app.context.store.config().heatingPlan,version:1});
 const base=`http://127.0.0.1:${app.server.address().port}`,post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});
 const response=await post('rooms',{...input(),id:undefined,sensorEntities:['climate.kitchen']});assert.equal(response.status,200);const room=await response.json();assert.equal(room.radiatorMode,'monitor');
 assert.equal(requests.filter(r=>r.options.method==='POST').length,0);
 let result=await post('heating/radiator',{roomId:room.id,mode:'follow'});assert.equal(result.status,200);assert.equal((await result.json()).mode,'follow');
 assert.equal((await post('heating/radiator',{roomId:room.id,mode:'follow',entityId:'climate.boiler'})).status,400);
 assert.equal((await post('heating/radiator',{roomId:room.id,mode:'random'})).status,400);
 const data=await (await fetch(base+'/api/heating')).json();assert.equal(data.mode,'listen');assert.equal(data.valveControlEnabled,true);assert.equal(data.rooms.find(r=>r.id===room.id).current,24);
 const pair=boiler.pair(),reply=boiler.exchange(signedMessage({v:1,device_id:pair.deviceId,boot_id:'a'.repeat(32),request_id:'b'.repeat(16),sequence:1,mode:'PID',telemetry:{flow_c:40}},pair.key));assert.equal(JSON.parse(reply.payload).authority,'pid');assert.equal(JSON.parse(reply.payload).lease_s,0);
 assert.ok(requests.filter(r=>r.options.method==='POST').every(r=>JSON.parse(r.options.body).entity_id==='climate.kitchen'));
});
