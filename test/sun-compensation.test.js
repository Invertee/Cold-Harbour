import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {defaults} from '../server/defaults.js';
import {validateRoom} from '../server/validate.js';
import {createApplication} from '../server/app.js';
import {evaluateHeating} from '../server/modules/heating.js';
import {valvePlan} from '../server/modules/thermostat.js';
import {sunlightReading,roomSunCompensation} from '../server/sun-compensation.js';
import {roomSunFields,bindRoomSun} from '../public/room-sun.js';
import {roomCard} from '../public/room-card.js';
import {roomResponsePreview} from '../public/room-control.js';

const now=Date.parse('2026-11-06T12:00:00Z'),stamp=new Date(now).toISOString();
const state=(entity_id,value,attributes={})=>({entity_id,state:String(value),attributes,last_reported:stamp});
const weather=cloud=>state('weather.home','partlycloudy',{cloud_coverage:cloud,temperature:10,temperature_unit:'°C'});
const sun=value=>state('sun.sun',value);
const room={id:'kitchen',name:'Kitchen',sensorEntities:['sensor.kitchen'],comfort:20,eco:16,weight:1,targetOffset:0,awayOffset:0,sunExposure:100};
function config(){
 const c=structuredClone(defaults);c.heatingPlan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);
 c.heatingPlan.activities.find(p=>p.id==='home').rooms={kitchen:{priority:'high',offset:0},office:{priority:'high',offset:0}};
 c.heatingPlan.weather={...c.heatingPlan.weather,enabled:true,entityId:'weather.home'};return c;
}
function evaluate({cloud=0,current=19,rooms=[room],extra=[],c=config(),memory=new Map()}={}){
 return evaluateHeating({rooms,rules:[],config:c,now,demandMemory:memory,states:[state('sensor.kitchen',current,{unit_of_measurement:'°C'}),weather(cloud),sun('above_horizon'),...extra]});
}

test('cloud cover continuously eases demand according to the single room slider',()=>{
 const results=[0,25,50,75,100].map(cloud=>evaluate({cloud}));
 assert.deepEqual(results.map(d=>d.rooms[0].sunCompensation.reductionC),[2,1.5,1,.5,0]);
 assert.equal(results[0].smartPlan.heat,false);assert.equal(results.at(-1).smartPlan.heat,true);
 assert.ok(results.every(d=>d.rooms[0].target===20&&d.rooms[0].deficit===1));
 assert.equal(evaluate({rooms:[{...room,sunExposure:50}]}).rooms[0].sunCompensation.reductionC,1);
 assert.equal(evaluate({rooms:[{...room,sunExposure:0}]}).rooms[0].callingForHeat,true);
});

test('solar demand drives valve opening, stop thresholds and boiler correction together',()=>{
 const cloudy=evaluate({current:17,cloud:100}),sunny=evaluate({current:17}),r=sunny.rooms[0];
 assert.equal(r.controlDeficit,1);assert.equal(valvePlan(r).opening,50);assert.equal(valvePlan(cloudy.rooms[0]).opening,100);
 assert.equal(valvePlan(r).closesAtC,18);assert.equal(valvePlan(r).opensBelowC,17.8);
 assert.ok(sunny.smartPlan.flowC<cloudy.smartPlan.flowC);assert.equal(sunny.smartPlan.weather.correctionC,5);
 assert.match(sunny.smartPlan.reason,/sunshine/);
 const coasting=evaluate().rooms[0];assert.equal(valvePlan(coasting).opening,0);assert.equal(valvePlan(coasting).deviceTarget,18);
 assert.equal(coasting.target,20);assert.equal(coasting.coasting,true);
});

test('a sunny kitchen cannot suppress a cold office and adjusted demand selects the leading room',()=>{
 const office={...room,id:'office',name:'Office',sensorEntities:['sensor.office'],sunExposure:0};
 let data=evaluate({rooms:[room,office],current:19,extra:[state('sensor.office',19.5,{unit_of_measurement:'°C'})]});
 assert.equal(data.smartPlan.leadRoomId,'office');assert.equal(data.smartPlan.heat,true);assert.equal(data.rooms[0].callingForHeat,false);
 data=evaluate({rooms:[room,office],current:17,extra:[state('sensor.office',18.5,{unit_of_measurement:'°C'})]});
 assert.equal(data.smartPlan.leadRoomId,'office','the kitchen has a larger raw shortfall but less heating demand');
});

test('weather changes retain the room hysteresis until its compensated stop threshold',()=>{
 const memory=new Map();
 assert.equal(evaluate({cloud:100,current:19.7,memory}).rooms[0].callingForHeat,true);
 assert.equal(evaluate({cloud:95,current:19.75,memory}).rooms[0].callingForHeat,true);
 assert.equal(evaluate({cloud:90,current:19.85,memory}).rooms[0].callingForHeat,false);
 assert.equal(evaluate({cloud:95,current:19.75,memory}).rooms[0].callingForHeat,false);
 assert.equal(evaluate({cloud:100,current:19.7,memory}).rooms[0].callingForHeat,true);
});

test('night, absent daylight and stale or invalid weather never reduce heating',()=>{
 const w=config().heatingPlan.weather;
 for(const states of [
  [weather(0),sun('below_horizon')],
  [weather(0)],
  [{...weather(0),state:'clear-night'},sun('above_horizon')],
  [{...weather(0),attributes:{is_daytime:false,cloud_coverage:0}}],
  [{...weather(0),state:'unavailable'},sun('above_horizon')],
  [{...weather(0),last_reported:new Date(now-121*60000).toISOString()},sun('above_horizon')],
  [{...weather(0),last_reported:new Date(now+120000).toISOString()},sun('above_horizon')],
  [weather(0),{...sun('above_horizon'),last_reported:'invalid'}],
  [],
 ]){
  const signal=sunlightReading(w,states,now),d=evaluateHeating({rooms:[room],rules:[],config:config(),now,states:[...states,state('sensor.kitchen',19,{unit_of_measurement:'°C'})]});
  assert.equal(signal.brightness,0);assert.equal(d.rooms[0].callingForHeat,true);assert.equal(d.rooms[0].sunCompensation.reductionC,0);
 }
});

test('current conditions offer a fallback when cloud cover is missing without inventing weather data',()=>{
 const w=config().heatingPlan.weather;
 for(const cloud of [undefined,null,false,'',-1,101,NaN]){
  const s=sunlightReading(w,[weather(cloud),sun('above_horizon')],now);assert.equal(s.brightness,.5);
 }
 assert.equal(sunlightReading(w,[{...weather(null),state:'sunny'}],now).brightness,1);
 assert.equal(sunlightReading(w,[{...weather(null),state:'cloudy'},sun('above_horizon')],now).brightness,0);
 assert.equal(sunlightReading(w,[{...weather(null),state:'rainy'},sun('above_horizon')],now).status,'unavailable');
});

test('sunlight uses the existing forecast entity alongside an outdoor sensor even with the curve off',()=>{
 const c=config();c.heatingPlan.weather={...c.heatingPlan.weather,enabled:false,entityId:'sensor.outside',forecastEntityId:'weather.home'};
 const d=evaluate({c});assert.equal(d.rooms[0].sunCompensation.reductionC,2);assert.equal(d.smartPlan.weather.enabled,false);
 assert.equal(sunlightReading({...c.heatingPlan.weather,forecastEntityId:''},[weather(0),sun('above_horizon')],now).status,'unavailable');
});

test('sun compensation never bypasses frost, missing readings or the temperature protection floor',()=>{
 let d=evaluate({current:6.9});assert.equal(d.smartPlan.kind,'frost');assert.equal(d.smartPlan.heat,true);assert.equal(d.rooms[0].sunCompensation.reductionC,0);assert.ok(d.smartPlan.flowC<=40);
 d=evaluate({current:'unavailable'});assert.equal(d.smartPlan.kind,'unavailable');assert.equal(d.rooms[0].sunCompensation.reductionC,0);assert.equal(valvePlan(d.rooms[0]).opening,0);
 assert.equal(roomSunCompensation(room,7,7.1,{status:'current',brightness:1}).heatingTargetC,7);
 assert.equal(roomSunCompensation(room,8,7.1,{status:'current',brightness:1}).heatingTargetC,7);
});

test('legacy rooms default to no sun impact and slider values are validated',()=>{
 const {sunExposure,...legacy}=room;assert.equal(validateRoom(legacy).sunExposure,0);
 for(const value of [-1,101,'75',false,NaN,Infinity,{}])assert.throws(()=>validateRoom({...room,sunExposure:value}),e=>e.status===400);
 assert.equal(validateRoom({...room,sunExposure:65}).sunExposure,65);
});

test('room editor offers one labelled slider and updates its accessible description',()=>{
 const html=roomSunFields({...room,sunExposure:65});assert.match(html,/type="range"/);assert.match(html,/value="65"/);assert.doesNotMatch(html,/type="number"|cloud_coverage|entityId/);
 const attributes={},output={},slider={value:'0',setAttribute:(key,value)=>attributes[key]=value,addEventListener:(name,fn)=>slider.update=fn};
 bindRoomSun({elements:{sunExposure:slider},querySelector:()=>output});assert.equal(output.textContent,'None');
 slider.value='65';slider.update();assert.equal(output.textContent,'High');assert.equal(attributes['aria-valuetext'],'High');
});

test('room cards explain solar coasting while retaining the scheduled target and nominal response preview',()=>{
 const data=evaluate(),r=data.rooms[0],html=roomCard(r,data.smartPlan);
 assert.match(html,/Allowing for sunshine/);assert.match(html,/Sunshine · heating eased/);assert.match(html,/Target 20.0/);assert.doesNotMatch(html,/Target satisfied/);
 assert.match(data.smartPlan.reason,/sunshine/);
 const preview=roomResponsePreview(r);assert.match(preview,/19.80°C/);assert.match(preview,/20.00°C/);
});

test('room sun impact saves through the API, survives reopening and only previews commands in Planning',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-sun-')),calls=[];
 const app=createApplication({dataDir:directory,haRequest:async(url,options={})=>{calls.push({url,options});return url.endsWith('/states')?[weather(0),sun('above_horizon'),state('sensor.kitchen',19,{unit_of_measurement:'°C'})].map(s=>({...s,last_reported:new Date().toISOString()})):{};},haRegistryRequest:async()=>[]});
 t.after(async()=>{await app.close();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&basename(path).startsWith('cold-sun-'));rmSync(path,{recursive:true,force:true});});
 const {store}=app.context;store.save('heatingPlan',config().heatingPlan);store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test-token');
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
 const post=body=>fetch(base+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});
 let response=await post({...room,sunExposure:65});assert.equal(response.status,200);assert.equal((await response.json()).sunExposure,65);
 response=await post({...room,sunExposure:101});assert.equal(response.status,400);assert.equal(store.list('rooms').find(r=>r.id==='kitchen').sunExposure,65);
 await app.tick();const data=await(await fetch(base+'/api/heating')).json(),kitchen=data.rooms.find(r=>r.id==='kitchen');
 assert.equal(kitchen.sunExposure,65);assert.equal(kitchen.coasting,true);assert.equal(data.smartPlan.planningOnly,true);
 assert.ok(calls.filter(c=>c.options.method==='POST').every(c=>c.url.includes('/weather/get_forecasts?return_response')));
 assert.equal((await(await fetch(base+'/api/rooms')).json()).find(r=>r.id==='kitchen').sunExposure,65);
});
