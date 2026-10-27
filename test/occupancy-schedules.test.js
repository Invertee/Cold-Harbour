import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {defaults} from '../server/defaults.js';
import {groupHeatingSchedules,resolveHeatingPlan,scheduledRoomTarget,temporaryHouseSetpoint} from '../server/heating-plan.js';
import {evaluateHeating} from '../server/modules/heating.js';
import {buildHeatingOutlook} from '../server/modules/heating-outlook.js';
import {validateHeatingPlan} from '../server/validate.js';
import {createStore} from '../server/db.js';
import {createApplication} from '../server/app.js';
import {scheduleMarkup} from '../public/modules/heating-controls.js';
import {signedMessage} from '../server/modules/boiler.js';

const now=Date.parse('2026-10-23T11:00:00Z');
const rooms=[{id:'office',name:'Office',sensorEntity:'sensor.office',comfort:20,eco:16,targetOffset:0,awayOffset:0,weight:1},{id:'kitchen',name:'Kitchen',sensorEntity:'sensor.kitchen',comfort:20,eco:16,targetOffset:0,awayOffset:0,weight:1}];
const person=(id,state)=>({entity_id:`person.${id}`,state});
function config(){
 const c=structuredClone(defaults),p=c.heatingPlan;p.people=[{entityId:'person.sam',name:'Sam'},{entityId:'person.partner',name:'Partner'}];p.awayDelayMinutes=10;
 p.activities=[{id:'home',name:'Home daytime',targetMode:'house',offset:0,rooms:{office:{offset:0,priority:'high'},kitchen:{offset:0,priority:'low'}}},{id:'away',name:'Away morning',targetMode:'setback',offset:0,rooms:{office:{offset:0,priority:'low'},kitchen:{offset:0,priority:'high'}}},{id:'away_late',name:'Away afternoon',targetMode:'house',offset:0,rooms:{office:{offset:0,priority:'high'},kitchen:{offset:0,priority:'low'}}}];
 p.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);p.awayTimeline=Array.from({length:7},()=>[{start:0,activityId:'away'},{start:780,activityId:'away_late'}]);return c;
}
const sensors=at=>rooms.map(r=>({entity_id:r.sensorEntity,state:'18',attributes:{unit_of_measurement:'°C'},last_reported:new Date(at).toISOString()}));
const evaluate=(c,people,at=now,memory={})=>evaluateHeating({rooms,rules:[],states:[...sensors(at),...people],config:c,now:at,occupancyMemory:memory});
function remove(directory){const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('cold-occupancy-'));rmSync(absolute,{recursive:true,force:true});}

test('occupancy selects independently configured room priorities, including High when everyone is away',()=>{
 const c=config();c.heatingPlan.awayDelayMinutes=0;
 let data=evaluate(c,[person('sam','home'),person('partner','not_home')]);assert.equal(data.plan.profile.id,'home');assert.deepEqual(data.rooms.map(r=>[r.priority,r.target]),[['high',20],['low',16]]);assert.equal(data.controlRoomId,'office');
 data=evaluate(c,[person('sam','not_home'),person('partner','work')]);assert.equal(data.plan.profile.id,'away');assert.deepEqual(data.rooms.map(r=>[r.priority,r.target]),[['low',16],['high',20]]);assert.equal(data.controlRoomId,'kitchen');assert.match(data.rooms[1].reason,/Away schedule.*comfort/);assert.equal(data.smartPlan.planningOnly,true);
 data=evaluate(c,[person('sam','not_home'),person('partner','work')],now+61*60000);assert.equal(data.plan.profile.id,'away_late');assert.equal(data.controlRoomId,'office');
});
test('departure delay, either person returning, unavailable tracking and manual occupancy select the right schedule',()=>{
 const c=config(),memory={},away=[person('sam','not_home'),person('partner','not_home')];
 assert.equal(evaluate(c,away,now,memory).plan.profile.id,'home');assert.equal(evaluate(c,away,now+9*60000,memory).plan.occupancy.held,true);assert.equal(evaluate(c,away,now+10*60000,memory).plan.profile.id,'away');
 assert.equal(evaluate(c,[person('sam','not_home'),person('partner','home')],now+11*60000,memory).plan.profile.id,'home');assert.equal(evaluate(c,[person('sam','unavailable'),person('partner','not_home')],now+12*60000,memory).plan.profile.id,'home');
 c.heatingPlan.occupancyMode='away';assert.equal(evaluate(c,[person('sam','home'),person('partner','home')]).plan.profile.id,'away');c.heatingPlan.occupancyMode='home';assert.equal(evaluate(c,away).plan.profile.id,'home');
});
test('grouping uses Monday for weekdays and Saturday for weekends independently for both occupancy plans',()=>{
 const p=config().heatingPlan;p.timeline[2]=[{start:0,activityId:'away'}];p.timeline[6]=[{start:0,activityId:'away_late'}];p.awayTimeline[6]=[{start:0,activityId:'home'}];
 const before=structuredClone(p),grouped=groupHeatingSchedules(p);assert.deepEqual(p,before);
 for(const key of ['timeline','awayTimeline']){for(const d of [1,2,3,4,5])assert.deepEqual(grouped[key][d],before[key][1]);for(const d of [0,6])assert.deepEqual(grouped[key][d],before[key][6]);}
 grouped.timeline[2][0].start=100;assert.equal(grouped.timeline[1][0].start,0);
 const validated=validateHeatingPlan(p);assert.deepEqual(validated.timeline[2],validated.timeline[1]);assert.deepEqual(validated.awayTimeline[0],validated.awayTimeline[6]);
 for(let day=0;day<7;day++)for(const mode of ['home','away']){p.occupancyMode=mode;const result=resolveHeatingPlan(p,[],Date.parse('2026-10-19T11:00:00Z')+day*86400000,'Europe/London');const key=mode==='away'?'awayTimeline':'timeline',index=day>=5?6:1;assert.equal(result.profile.id,before[key][index][0].activityId);}
});
test('migration archives individual days, preserves credentials and room mappings, and survives reopening',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-occupancy-'));let store=createStore(directory);
 try{
  const previous=config().heatingPlan;previous.timeline[2]=[{start:0,activityId:'away_late'}];previous.awayTimeline[0]=[{start:0,activityId:'home'}];store.save('heatingPlan',previous);store.secret('haToken','keep-ha');store.secret('boilerKey','keep-pair');const oldRooms=store.list('rooms');
  store.db.prepare("DELETE FROM settings WHERE section='heatingPlanBeforeOccupancySchedules'").run();store.db.prepare('DELETE FROM migrations WHERE version=9').run();store.close();store=createStore(directory);
  assert.deepEqual(JSON.parse(store.db.prepare("SELECT value FROM settings WHERE section='heatingPlanBeforeOccupancySchedules'").get().value),previous);assert.deepEqual(store.config().heatingPlan,groupHeatingSchedules(previous));assert.equal(store.secret('haToken'),'keep-ha');assert.equal(store.secret('boilerKey'),'keep-pair');assert.deepEqual(store.list('rooms'),oldRooms);const migrated=store.config().heatingPlan;store.close();store=createStore(directory);assert.deepEqual(store.config().heatingPlan,migrated);
 }finally{store.close();remove(directory);}
});
test('schedule dialog has occupancy tabs and only weekday/weekend rows with distinct periods and priorities',()=>{
 const p=config().heatingPlan,home=scheduleMarkup(p,rooms),away=scheduleMarkup(p,rooms,undefined,'away');
 for(const html of [home,away]){assert.match(html,/Someone home/);assert.match(html,/Everyone away/);assert.equal((html.match(/class="routine-track"/g) || []).length,2);assert.match(html,/Weekdays/);assert.match(html,/Weekends/);assert.doesNotMatch(html,/Individual day|schedule-day|Monday|Sunday/);assert.match(html,/value="high"/);assert.match(html,/value="low"/);assert.match(html,/Save schedule saves changes to both/);}
 assert.match(home,/Home daytime/);assert.doesNotMatch(home.split('<form')[0],/Away morning/);assert.match(away,/Away morning/);assert.match(away,/Away afternoon/);assert.match(away,/1:00 pm/);assert.match(away,/data-schedule-occupancy="away" class="selected" aria-pressed="true"/);
});
test('HTTP saves preserve separate occupancy schedules across restarts and still never grant remote authority',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-occupancy-'));let app=createApplication({dataDir:directory});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();remove(directory);});
 const base=`http://127.0.0.1:${app.server.address().port}`,p=config().heatingPlan;
 p.scheduleOverride={entityId:'binary_sensor.gone_to_bed',activityId:'away_late'};p.activities[2].houseTarget=18.5;
 const response=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify({section:'heatingPlan',values:p})});assert.equal(response.status,200);assert.deepEqual(app.context.store.config().heatingPlan.awayTimeline,p.awayTimeline);
 await app.close();app=createApplication({dataDir:directory});assert.deepEqual(app.context.store.config().heatingPlan,validateHeatingPlan(p));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const cleared=await fetch(`http://127.0.0.1:${app.server.address().port}/api/settings`,{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify({section:'heatingPlan',values:{...p,scheduleOverride:null}})});
 assert.equal(cleared.status,200);assert.equal(app.context.store.config().heatingPlan.scheduleOverride,null);
 const pair=app.context.boiler.pair(),message={v:1,device_id:pair.deviceId,boot_id:'a'.repeat(32),request_id:'b'.repeat(16),sequence:1,mode:'Cold Harbour',telemetry:{flow_c:40}};const reply=JSON.parse(app.context.boiler.exchange(signedMessage(message,pair.key)).payload);assert.equal(reply.authority,'pid');assert.equal(reply.lease_s,0);
});

test('binary sensor override wins across occupancy, weekends and midnight, then resumes the current schedule',()=>{
 const c=config(),p=c.heatingPlan;p.scheduleOverride={entityId:'binary_sensor.gone_to_bed',activityId:'away_late'};p.activities[2].houseTarget=18.5;
 for(const occupancy of ['home','away'])for(const at of [now,now+86400000,now+3*86400000]){
  p.occupancyMode=occupancy;
  const data=evaluate(c,[{entity_id:'binary_sensor.gone_to_bed',state:'on'}],at);
  assert.equal(data.plan.profile.id,'away_late');assert.equal(data.plan.override.entityId,p.scheduleOverride.entityId);
  assert.equal(data.plan.activeTarget,18.5);assert.deepEqual(data.rooms.map(r=>r.target),[18.5,16]);assert.match(data.rooms[0].reason,/sensor override/);
  for(const state of ['off','unknown','unavailable',null]){
   const states=state===null?[]:[{entity_id:'binary_sensor.gone_to_bed',state}];
   const normal=resolveHeatingPlan({...p,scheduleOverride:null},states,at,'Europe/London');
   const resumed=evaluate(c,states,at);assert.equal(resumed.plan.profile.id,normal.profile.id);assert.equal(resumed.plan.override,undefined);
  }
 }
});

test('period setpoints preserve room offsets, cap Low and retain the house default',()=>{
 const c=config(),p=c.heatingPlan;p.activities[0].houseTarget=14;
 let data=evaluate(c,[]);assert.deepEqual(data.rooms.map(r=>r.target),[14,14]);
 p.activities[0].houseTarget=28;data=evaluate(c,[]);assert.equal(data.rooms[0].target,28);
 delete p.activities[0].houseTarget;data=evaluate(c,[]);assert.deepEqual(data.rooms.map(r=>r.target),[20,16]);
 assert.equal(scheduledRoomTarget({...rooms[0],targetOffset:1.5},'high',p,{houseTarget:18}),19.5);
 assert.equal(scheduledRoomTarget({...rooms[0],targetOffset:-2,awayOffset:1},'low',p,{houseTarget:18}),16);
});

test('new schedule settings validate and the dialog exposes sensor, profile and optional setpoint',()=>{
 const p=config().heatingPlan;p.activities[0].houseTarget=18.5;p.scheduleOverride={entityId:'binary_sensor.gone_to_bed',activityId:'home'};
 const saved=validateHeatingPlan(p);assert.equal(saved.activities[0].houseTarget,18.5);assert.deepEqual(saved.scheduleOverride,p.scheduleOverride);
 for(const mutate of [p=>p.activities[0].houseTarget=NaN,p=>p.activities[0].houseTarget=29,p=>p.scheduleOverride.activityId='missing',p=>p.scheduleOverride.entityId='switch.bed',p=>p.scheduleOverride.entityId='']){const bad=structuredClone(p);mutate(bad);assert.throws(()=>validateHeatingPlan(bad),e=>e.status===400);}
 const html=scheduleMarkup(p,rooms,undefined,'home',[{entity_id:'binary_sensor.gone_to_bed',attributes:{friendly_name:'Gone to bed'}}]);
 assert.match(html,/name="periodTarget" value="18.5"/);assert.match(html,/Gone to bed/);assert.match(html,/name="overrideActivity"/);assert.match(html,/overrides both occupancy schedules, every day/);
});

test('forecast guidance uses each period setpoint in hourly targets and daily flow ranges',()=>{
 const c=config(),p=c.heatingPlan;p.activities[0].houseTarget=18.5;p.activities[1].houseTarget=17;p.activities[2].houseTarget=22;
 const forecasts={enabled:true,hourly:{fresh:true,points:[{at:new Date(now).toISOString(),temperatureC:5}]},daily:{fresh:true,points:[{at:new Date(now).toISOString(),temperatureC:5,lowC:0}]}};
 const build=()=>buildHeatingOutlook({data:evaluate(c,[]),settings:p,forecasts,learning:{rooms:[]},timezone:'Europe/London',now});
 const outlook=build();assert.equal(outlook.scenarios.home.hourly[0].rooms[0].targetC,18.5);assert.equal(outlook.scenarios.away.hourly[0].rooms[1].targetC,17);
 const higherFlow=outlook.scenarios.away.daily[0].flowHighC;p.activities[2].houseTarget=18;
 assert.ok(build().scenarios.away.daily[0].flowHighC<higherFlow);
});


test('manual setpoint replaces period temperature until the next boundary without changing saved targets',()=>{
 const c=config(),p=c.heatingPlan;p.activities[0].houseTarget=20;p.houseTarget=19;
 p.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'},{start:780,activityId:'away_late'}]);p.activities[2].houseTarget=18;
 const resolved=evaluate(c,[]).plan;assert.equal(resolved.activeTarget,20);
 p.setpointOverride=temporaryHouseSetpoint(p,resolved,21.5,now,'Europe/London');
 assert.equal(p.setpointOverride.expiresAt,'2026-10-23T12:00:00.000Z');
 const saved=validateHeatingPlan(p);assert.deepEqual(saved.setpointOverride,p.setpointOverride);
 let data=evaluate(c,[]);assert.equal(data.plan.activeTarget,21.5);assert.deepEqual(data.rooms.map(r=>r.target),[21.5,16]);assert.equal(data.plan.scheduledTarget,20);
 data=evaluate(c,[],Date.parse(p.setpointOverride.expiresAt)-1);assert.equal(data.plan.activeTarget,21.5);
 data=evaluate(c,[],Date.parse(p.setpointOverride.expiresAt));assert.equal(data.plan.activeTarget,18);assert.equal(data.plan.setpointOverride,undefined);assert.equal(data.rooms[0].target,18);
 assert.equal(p.houseTarget,19);assert.equal(p.activities[0].houseTarget,20);
 assert.equal(evaluate(c,[],now+7*86400000).plan.activeTarget,20);
});

test('temporary setpoints expire at midnight, repeated-profile boundaries and across daylight saving changes',()=>{
 for(const [at,end,slots] of [
  ['2026-10-23T22:30:00Z','2026-10-23T23:00:00.000Z',[{start:0,activityId:'home'}]],
  ['2026-10-23T11:00:00Z','2026-10-23T12:00:00.000Z',[{start:0,activityId:'home'},{start:780,activityId:'home'}]],
  ['2026-10-25T00:30:00Z','2026-10-25T02:00:00.000Z',[{start:0,activityId:'home'},{start:120,activityId:'home'}]],
  ['2026-03-29T00:30:00Z','2026-03-29T01:00:00.000Z',[{start:0,activityId:'home'},{start:120,activityId:'home'}]],
 ]){
  const c=config(),p=c.heatingPlan;p.timeline=Array.from({length:7},()=>slots);const start=Date.parse(at),resolved=evaluate(c,[],start).plan;
  p.setpointOverride=temporaryHouseSetpoint(p,resolved,22,start,'Europe/London');assert.equal(p.setpointOverride.expiresAt,end);
  assert.equal(evaluate(c,[],start).plan.activeTarget,22);assert.equal(evaluate(c,[],Date.parse(end)).plan.activeTarget,20);
 }
});

test('temporary setpoint HTTP changes persist across restart and reject invalid requests',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-occupancy-'));let app=createApplication({dataDir:directory});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();remove(directory);});
 const base='http://127.0.0.1:'+app.server.address().port,post=body=>fetch(base+'/api/heating/setpoint',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});
 const p=config().heatingPlan;p.houseTarget=19;p.activities[0].houseTarget=20;app.context.store.save('heatingPlan',p);
 for(const body of [{target:29},{target:6},{target:'21'},{target:21,enabled:true},{}])assert.equal((await post(body)).status,400);
 const response=await post({target:21.5});assert.equal(response.status,200);const data=await response.json();assert.equal(data.plan.activeTarget,21.5);assert.equal(data.plan.scheduledTarget,20);assert.equal(data.mode,'listen');
 const saved=app.context.store.config().heatingPlan;assert.equal(saved.houseTarget,19);assert.equal(saved.activities[0].houseTarget,20);assert.equal(saved.setpointOverride.target,21.5);
 await app.close();app=createApplication({dataDir:directory});assert.deepEqual(app.context.store.config().heatingPlan,saved);
});
