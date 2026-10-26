import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {defaults} from '../server/defaults.js';
import {defaultHeatingPlan,migrateHeatingPlan,upgradeHeatingPlan} from '../server/heating-plan.js';
import {sampleRooms,sampleRules} from '../server/defaults.js';
import {validateHeatingPlan} from '../server/validate.js';
import {evaluateHeating} from '../server/modules/heating.js';
import {outdoorReading,defaultWeatherPlan} from '../server/smart-thermostat.js';
import {createStore} from '../server/db.js';
import {createApplication} from '../server/app.js';
import {radiatorCommand,createRadiatorControl} from '../server/modules/radiators.js';
import {createHeatingHistory} from '../server/modules/heating-history.js';
import {signedMessage} from '../server/modules/boiler.js';
import {scheduleMarkup,planningControls} from '../public/modules/heating-controls.js';
import {heatingView} from '../public/modules/heating-view.js';
import {modeName} from '../public/heating-mode.js';
const now=Date.parse('2026-10-23T11:00:00Z'),stamp=new Date(now).toISOString();
const rooms=[{id:'office',name:'Office',sensorEntities:['sensor.office'],comfort:20,eco:16,targetOffset:0,awayOffset:0,weight:1},{id:'kitchen',name:'Kitchen',sensorEntities:['sensor.kitchen'],comfort:20,eco:16,targetOffset:0,awayOffset:0,weight:5}];
function config(){const config=structuredClone(defaults);config.heatingPlan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);config.heatingPlan.activities.find(p=>p.id==='home').rooms={office:{offset:0,priority:'high'},kitchen:{offset:0,priority:'low'}};return config;}
const temp=(entity_id,value,unit='°C')=>({entity_id,state:String(value),attributes:{unit_of_measurement:unit},last_reported:stamp});
function evaluate(c=config(),states=[temp('sensor.office',19),temp('sensor.kitchen',24)],customRooms=rooms){return evaluateHeating({rooms:customRooms,rules:[],config:c,states,now});}
const remove=directory=>{const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&basename(path).startsWith('cold-smart-'));rmSync(path,{recursive:true,force:true});};

test('scheduled priority is strictly High/Low with no manual activity, numeric priority or malformed weather',()=>{
 const p=config().heatingPlan;assert.equal(validateHeatingPlan(p).version,2);
 for(const change of [p=>p.activities[0].rooms.office.priority=5,p=>p.manualActivity='home',p=>p.awayTarget=22,p=>p.weather.minFlow=70,p=>p.weather.maxFlow=30,p=>p.weather.entityId='climate.boiler',p=>p.weather.designOutdoor=5,p=>p.weather.deficitGain=NaN,p=>p.weather={...p.weather,magic:1},p=>p.weather=false]){const next=structuredClone(p);change(next);assert.throws(()=>validateHeatingPlan(next),e=>e.status===400);}
});
test('high priority follows the house setpoint; sunny low kitchen cannot cancel comfort demand',()=>{
 const c=config();let data=evaluate(c);assert.deepEqual(data.rooms.map(r=>[r.priority,r.target]),[['high',20],['low',16]]);assert.equal(data.controlRoomId,'office');assert.equal(data.smartPlan.kind,'comfort');assert.equal(data.smartPlan.heat,true);assert.equal(data.smartPlan.planningOnly,true);assert.equal(data.valveControlEnabled,false);
 c.heatingPlan.houseTarget=21;data=evaluate(c);assert.equal(data.rooms[0].target,21);assert.equal(data.rooms[1].target,16);
});
test('high room demand leads over larger low deficits and room weight; low still protects setback',()=>{
 let data=evaluate(config(),[temp('sensor.office',19.5),temp('sensor.kitchen',10)]);assert.equal(data.controlRoomId,'office');assert.equal(data.smartPlan.highDemandCount,1);assert.equal(data.smartPlan.lowDemandCount,1);
 data=evaluate(config(),[temp('sensor.office',20.5),temp('sensor.kitchen',15)]);assert.equal(data.controlRoomId,'kitchen');assert.equal(data.smartPlan.kind,'setback');assert.equal(data.rooms[1].target,16);
 data=evaluate(config(),[temp('sensor.office',20),temp('sensor.kitchen',16)]);assert.equal(data.smartPlan.heat,false);assert.equal(data.smartPlan.flowC,0);
});
test('room offsets are applied once, low never exceeds comfort, and presence cannot change schedule priority',()=>{
 const custom=structuredClone(rooms);custom[0].targetOffset=-2;custom[0].awayOffset=10;custom[1].presenceRules=[{entityId:'switch.tv',condition:'is',value:'on'}];custom[1].presenceMode='priority';
 const c=config();c.heatingPlan.activities[0].rooms.office.priority='low';const data=evaluate(c,[temp('sensor.office',17),temp('sensor.kitchen',17),{entity_id:'switch.tv',state:'on'}],custom);
 assert.equal(data.rooms[0].target,18);assert.equal(data.rooms[1].occupied,true);assert.equal(data.rooms[1].priority,'low');assert.equal(data.rooms[1].target,16);
});
test('default away schedule uses setback; unknown occupancy retains the home schedule',()=>{
 const c=config();c.heatingPlan.people=[{entityId:'person.sam',name:'Sam'}];c.heatingPlan.awayDelayMinutes=0;
 let data=evaluate(c,[temp('sensor.office',19),{entity_id:'person.sam',state:'not_home'}]);assert.ok(data.rooms.every(r=>r.priority==='low'));assert.equal(data.rooms[0].target,16);
 data=evaluate(c,[temp('sensor.office',19),{entity_id:'person.sam',state:'unavailable'}]);assert.equal(data.rooms[0].priority,'high');
});
test('missing rooms are excluded; room frost takes precedence with a 40°C planning cap',()=>{
 let data=evaluate(config(),[temp('sensor.office','unavailable'),temp('sensor.kitchen',24)]);assert.equal(data.smartPlan.heat,false);assert.deepEqual(data.smartPlan.missingRooms,['office']);
 data=evaluate(config(),[]);assert.equal(data.smartPlan.kind,'unavailable');assert.equal(data.smartPlan.flowC,0);
 const c=config();c.heatingPlan.awayTarget=5;data=evaluate(c,[temp('sensor.office',19),temp('sensor.kitchen',6.9)]);assert.equal(data.smartPlan.kind,'frost');assert.equal(data.controlRoomId,'kitchen');assert.equal(data.rooms[1].target,7);assert.ok(data.smartPlan.flowC<=40);
});
test('weather increases planned flow as outside temperature drops and remains capped under large deficits',()=>{
 const c=config();c.heatingPlan.weather={...defaultWeatherPlan,enabled:true,entityId:'sensor.outside'};
 const at=outside=>evaluate(c,[temp('sensor.office',19.5),temp('sensor.kitchen',24),temp('sensor.outside',outside)]).smartPlan;
 const mild=at(15),cold=at(5),freezing=at(-10);assert.ok(mild.flowC<cold.flowC);assert.ok(cold.flowC<=freezing.flowC);assert.equal(freezing.flowC,52);assert.equal(cold.weather.status,'current');assert.equal(cold.weather.correctionC,2.5);
 const satisfied=evaluate(c,[temp('sensor.office',21),temp('sensor.kitchen',24),temp('sensor.outside',-15)]).smartPlan;assert.equal(satisfied.flowC,0);assert.equal(satisfied.heat,false);
});
test('weather reads weather.temperature or sensor state, converts Fahrenheit and rejects stale or invalid sources',()=>{
 const settings={...defaultWeatherPlan,enabled:true,entityId:'weather.home'},weather={entity_id:'weather.home',state:'sunny',last_reported:stamp,attributes:{temperature:50,temperature_unit:'°F'}};
 assert.equal(outdoorReading(settings,[weather],now).temperature,10);
 assert.equal(outdoorReading({...settings,entityId:'sensor.outside'},[temp('sensor.outside',50,'°F')],now).temperature,10);
 for(const state of [{...weather,state:'unavailable'},{...weather,last_reported:new Date(now-121*60000).toISOString()},{...weather,last_reported:new Date(now+120000).toISOString()},...['',false,null,NaN,120].map(value=>({...weather,attributes:{temperature:value,temperature_unit:'°C'}})),{...weather,attributes:{temperature:10}}])assert.equal(outdoorReading(settings,[state],now),null);
 const c=config();c.heatingPlan.weather=settings;const fallback=evaluate(c).smartPlan;assert.equal(fallback.weather.status,'unavailable');assert.equal(fallback.flowC,40);assert.match(fallback.weather.fallback,/unavailable/);
});
test('priority migration preserves period times and household settings, converts 3–5 to High, removes hidden offsets',()=>{
 const previous=migrateHeatingPlan(sampleRooms,sampleRules,'work');previous.people=[{entityId:'person.sam',name:'Sam'}];const upgraded=upgradeHeatingPlan(previous,sampleRooms);
 assert.equal(upgraded.version,2);assert.equal(upgraded.manualActivity,'auto');assert.deepEqual(upgraded.timeline,previous.timeline);assert.deepEqual(upgraded.people,previous.people);
 for(const profile of upgraded.activities)for(const room of sampleRooms){const before=previous.activities.find(p=>p.id===profile.id).rooms[room.id];assert.equal(profile.rooms[room.id].priority,profile.targetMode==='setback'?'low':Number(before?.priority)>=3?'high':'low');assert.equal(profile.offset,0);assert.equal(profile.rooms[room.id].offset,0);}
 assert.doesNotThrow(()=>validateHeatingPlan(upgraded));
});
test('database upgrade archives the full former plan and leaves room mappings, history and credentials intact',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-smart-'));let store=createStore(directory);
 try{
  const old=migrateHeatingPlan(sampleRooms,sampleRules,'work');store.secret('haToken','keep-ha');store.secret('boilerKey','keep-pair');store.save('heatingPlan',old);store.db.prepare("DELETE FROM settings WHERE section='heatingPlanBeforePriority'").run();store.db.prepare('DELETE FROM migrations WHERE version=8').run();const before=store.list('rooms');store.close();store=createStore(directory);
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT value FROM settings WHERE section='heatingPlanBeforePriority'").get().value),old);assert.equal(store.config().heatingPlan.version,2);assert.equal(store.secret('haToken'),'keep-ha');assert.equal(store.secret('boilerKey'),'keep-pair');assert.deepEqual(store.list('rooms'),before);assert.ok(!Object.hasOwn(store.config(),'heatingPlanBeforePriority'));
 }finally{store.close();remove(directory);}
});
test('planning blocks previous Follow/Focus/Pause valve commands and every signed boiler lease remains PID',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-smart-')),app=createApplication({dataDir:directory});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();remove(directory);});
 const c=config();for(const radiatorMode of ['follow','focus','pause'])assert.equal(radiatorCommand({...rooms[0],radiatorMode},null,c).ready,false);
 let writes=0;const stored={...rooms[0],radiatorEntity:'climate.office',radiatorMode:'follow'},controller=createRadiatorControl({store:{config:()=>c,list:()=>[stored]},ha:{applyRadiator:()=>writes++}},()=>({rooms:[{...stored,fresh:true,target:20}]}));await controller.sync(now);assert.equal(writes,0);
 const base=`http://127.0.0.1:${app.server.address().port}`;const response=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify({section:'heatingPlan',values:c.heatingPlan})});assert.equal(response.status,200);
 const data=await (await fetch(base+'/api/heating')).json();assert.equal(data.smartPlan.planningOnly,true);assert.equal(data.valveControlEnabled,false);assert.equal(data.mode,'listen');
 app.context.store.put('rooms',{...rooms[0],radiatorEntity:'climate.office',radiatorMode:'monitor'});
 const valve=await fetch(base+'/api/heating/radiator',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify({roomId:'office',mode:'follow'})});assert.equal(valve.status,409);assert.equal(app.context.store.list('rooms').find(r=>r.id==='office').radiatorMode,'monitor');
 const pair=app.context.boiler.pair(),message={v:1,device_id:pair.deviceId,boot_id:'a'.repeat(32),request_id:'b'.repeat(16),sequence:1,mode:'Cold Harbour',telemetry:{flow_c:40}};const reply=JSON.parse(app.context.boiler.exchange(signedMessage(message,pair.key)).payload);assert.equal(reply.authority,'pid');assert.equal(reply.lease_s,0);assert.equal(reply.flow_c,0);
});
test('minute history retains plan, weather and priority beside actual measurements without inventing actual boiler values',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-smart-')),store=createStore(directory);
 try{
  const c=config();c.heatingPlan.weather={...defaultWeatherPlan,enabled:true,entityId:'sensor.outside'};const data=evaluate(c,[temp('sensor.office',19),temp('sensor.kitchen',24),temp('sensor.outside',10)]);
  const history=createHeatingHistory({store,boiler:{status:()=>({connected:false})}},()=>data);history.capture(now);const chart=history.chart(60,now),row=chart.points[0];assert.equal(row.planned_flow_c,data.smartPlan.flowC);assert.equal(row.outdoor_c,10);assert.equal(row.weather_status,'current');assert.equal(row.priority_office,'high');assert.equal(row.priority_kitchen,'low');assert.equal(row.requested_flow_c,null);assert.equal(row.modulation_pct,null);assert.match(row.planned_reason,/Office/);
 }finally{store.close();remove(directory);}
});
test('schedule dialog uses high/low selectors and twelve-hour draggable periods without activity presets',()=>{
 const plan=config().heatingPlan;plan.timeline[1].push({start:540,activityId:'work'});const html=scheduleMarkup(plan,rooms);assert.match(html,/Heating schedule/);assert.match(html,/9:00 am/);assert.match(html,/routine-boundary/);assert.match(html,/value="high"/);assert.match(html,/value="low"/);assert.doesNotMatch(html,/Current activity|Choose an activity|Activity timeline|type="number"[^>]*max="5"/);
 const controls=planningControls(evaluate());assert.match(controls,/edit-schedule/);assert.match(controls,/edit-household/);assert.match(controls,/edit-weather/);assert.doesNotMatch(controls,/routine-track|manualActivity|name="people"/);assert.equal(modeName('Cold Harbour unavailable: PID'),'Smart Thermostat unavailable: Local PID');assert.equal(modeName('PID'),'Local PID');
 const unsafe=scheduleMarkup(plan,[{id:'x" onfocus="bad',name:'<img src=x onerror=bad>'}]);assert.doesNotMatch(unsafe,/<img|name="priority_x" onfocus/);assert.match(unsafe,/&lt;img/);
});
test('heating page shows the planned decision and actual Local PID separately with no manual radiator selector',async t=>{
 const beforeFetch=globalThis.fetch,beforeLocation=globalThis.location,data=evaluate();globalThis.location={href:'http://test.local/'};
 globalThis.fetch=async url=>{const path=url.pathname;const result=path==='/api/heating'?data:path==='/api/boiler'?{connected:true,telemetry:{pid_target_c:19,effective_mode:'PID'}}:path==='/api/heating/insights'?{rooms:[]}: {points:[],rooms:[],resolution:'Test history'};return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});};t.after(()=>{globalThis.fetch=beforeFetch;globalThis.location=beforeLocation;});
 const html=await heatingView.render({config:{general:{timezone:'Europe/London'}}});assert.match(html,/Heat planned/);assert.match(html,/Local PID/);assert.match(html,/High priority/);assert.match(html,/Low priority/);assert.match(html,/Office is 1.0°C below/);assert.match(html,/target-distance/);assert.match(html,/open-heating-analysis/);assert.doesNotMatch(html,/observation-summary|Boiler connection|house-target-form|Current activity|Priority [1-5]\/5|data-radiator-room|routine-track/);
});
