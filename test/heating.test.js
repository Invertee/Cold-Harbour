import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHeating,ruleActive } from '../server/modules/heating.js';
import { temperature } from '../server/integrations/home-assistant.js';
import { defaults } from '../server/defaults.js';
import { dayStart,periodRange } from '../server/time.js';

const now=Date.parse('2026-10-21T12:00:00Z');
const sensor=(entity_id,value,extra={})=>({entity_id,state:String(value),attributes:{unit_of_measurement:'°C'},last_reported:new Date(now).toISOString(),...extra});
function fixture(){
  const config=structuredClone(defaults);
  delete config.heatingPlan; // Legacy schedule evaluator remains covered for migration comparisons.
  const rooms=[{id:'office',name:'Office',sensorEntity:'sensor.office',comfort:21,eco:16,weight:1},{id:'living',name:'Living',sensorEntity:'sensor.living',comfort:20,eco:17,weight:1}];
  const states=[sensor('sensor.office',18),sensor('sensor.living',22),sensor('climate.pid','heat',{attributes:{current_temperature:20,temperature_unit:'°C',supported_features:1,min_temp:7,max_temp:28,target_temp_step:.5}})];
  const rules=[{id:'work',name:'Working',roomId:'office',days:[3],start:'09:00',end:'17:00',target:21,priority:4,activity:'work',enabled:true}];
  return {rooms,rules,states,config,now};
}
test('room priority identifies demand without producing a boiler or thermostat command',()=>{
  const result=evaluateHeating(fixture());assert.equal(result.activity,'work');assert.equal(result.average,18.8);assert.equal(result.desired,20.8);assert.equal(result.mode,'listen');assert.equal(result.target,undefined);assert.equal(result.flowTarget,undefined);assert.equal(result.blocked,null);
});
test('stale sensors are excluded rather than converted to zero',()=>{const f=fixture();f.states[0].state='unavailable';let result=evaluateHeating(f);assert.equal(result.average,22);f.states[1].last_reported=new Date(now-3600000).toISOString();result=evaluateHeating(f);assert.equal(result.average,null);assert.match(result.blocked,/fresh/);});

test('unchanged temperatures remain usable when genuine source reports are recent',()=>{
 const f=fixture();f.states[0].last_changed=f.states[0].last_updated=new Date(now-86400000).toISOString();
 let office=evaluateHeating(f).rooms[0];assert.equal(office.current,18);assert.equal(office.measurements[0].status,'fresh');
 assert.equal(office.sourceAt,f.states[0].last_reported);
 f.now=now+31*60000;office=evaluateHeating(f).rooms[0];assert.equal(office.current,null);assert.equal(office.measurements[0].status,'stale');
 f.states[0].last_reported=new Date(f.now).toISOString();assert.equal(evaluateHeating(f).rooms[0].current,18);
});

test('a slow-reporting room has its own bounded freshness window without refreshing cached timestamps',()=>{
 const f=fixture(),reportedAt=new Date(now-75*60000).toISOString();
 f.rooms[0].sensorFreshnessMinutes=120;f.states[0].last_reported=f.states[1].last_reported=reportedAt;
 let result=evaluateHeating(f);assert.equal(result.rooms[0].current,18);assert.equal(result.rooms[1].current,null);
 assert.equal(result.rooms[0].sourceAt,reportedAt);assert.equal(result.rooms[0].measurements[0].freshnessMinutes,120);
 f.now=now+46*60000;result=evaluateHeating(f);assert.equal(result.rooms[0].current,null);assert.equal(result.rooms[0].measurements[0].reportedAt,reportedAt);
 f.rooms[0].sensorFreshnessMinutes=null;f.now=now;assert.equal(evaluateHeating(f).rooms[0].current,null);
});

test('longer freshness windows still reject unavailable, invalid and future sensor readings',()=>{
 const f=fixture();f.rooms[0].sensorFreshnessMinutes=1440;
 for(const state of ['unavailable','unknown','', 'invalid']){f.states[0].state=state;assert.equal(evaluateHeating(f).rooms[0].current,null);}
 f.states[0].state='18';f.states[0].last_reported=new Date(now+120000).toISOString();assert.equal(evaluateHeating(f).rooms[0].current,null);
});
test('room planning needs no legacy PID baseline or climate mapping',()=>{const f=fixture();f.states.pop();assert.equal(evaluateHeating(f).blocked,null);});
test('away uses eco targets and ignores activity priorities',()=>{const f=fixture();f.config.heating.activity='away';const result=evaluateHeating(f);assert.equal(result.desired,16.5);assert.equal(result.rooms[0].priority,1);});

test('manual work mode uses work priorities outside scheduled hours',()=>{const f=fixture();f.now=Date.parse('2026-10-21T19:00:00Z');for(const state of f.states)state.last_reported=new Date(f.now).toISOString();f.config.heating.activity='work';assert.equal(evaluateHeating(f).rooms[0].priority,4);});
test('sensor units and timestamps are validated',()=>{
  assert.equal(temperature(sensor('sensor.a',''),now),null);assert.equal(temperature(sensor('sensor.a',70,{attributes:{unit_of_measurement:'°F'}}),now),21.11111111111111);assert.equal(temperature(sensor('sensor.a',20,{attributes:{unit_of_measurement:'kWh'}}),now),null);assert.equal(temperature(sensor('sensor.a',20,{last_reported:'invalid'}),now),null);assert.equal(temperature(sensor('sensor.a',20,{last_reported:new Date(now+3600000).toISOString()}),now),null);
});
test('overnight routine belongs to the previous start day after midnight',()=>{
  const rule={enabled:true,days:[5],start:'22:00',end:'06:30'};
  assert.equal(ruleActive(rule,Date.parse('2026-10-23T22:15:00Z'),'Europe/London'),true);
  assert.equal(ruleActive(rule,Date.parse('2026-10-24T04:30:00Z'),'Europe/London'),true);
  assert.equal(ruleActive(rule,Date.parse('2026-10-25T04:30:00Z'),'Europe/London'),false);
});
test('day boundaries respect both UK clock changes',()=>{
  assert.equal(dayStart('2026-03-30','Europe/London')-dayStart('2026-03-29','Europe/London'),23*3600000);
  assert.equal(dayStart('2026-10-26','Europe/London')-dayStart('2026-10-25','Europe/London'),25*3600000);
  const range=periodRange('yesterday',Date.parse('2026-10-26T12:00:00Z'),'Europe/London');assert.equal(range.end-range.start,25*3600000);
});
test('a sunny kitchen cannot cancel a cooler room demand',()=>{
  const f=fixture();f.rules=[];f.states[0].state='21';f.states[1].state='18';
  f.rooms.push({id:'kitchen',name:'Kitchen',sensorEntity:'sensor.kitchen',comfort:20,eco:16,weight:5});
  f.states.push(sensor('sensor.kitchen',30));
  const result=evaluateHeating(f);
  assert.ok(result.average>result.desired);assert.equal(result.controlRoomId,'living');assert.equal(result.demandingRoomCount,1);assert.equal(result.mode,'listen');assert.equal(result.target,undefined);
  assert.equal(result.rooms[2].callingForHeat,false);assert.equal(result.valveControlEnabled,false);
});

test('multiple temperatures are averaged only within their room and stale readings skipped',()=>{
  const f=fixture();f.rooms[0].sensorEntities=['sensor.office','sensor.office_second','sensor.office_stale'];
  f.states.push(sensor('sensor.office_second',20),sensor('sensor.office_stale',30,{last_reported:new Date(now-3600000).toISOString()}));
  const room=evaluateHeating(f).rooms[0];assert.equal(room.current,19);assert.equal(room.sensorCount,3);assert.equal(room.sensorCountUsed,2);
});

test('stateful device presence survives unchanged HA timestamps and holds after use',()=>{
  const f=fixture();f.rules=[];f.presenceMemory=new Map();
  Object.assign(f.rooms[0],{presenceMode:'comfort',presenceHoldMinutes:20,presenceRules:[{entityId:'switch.computer',condition:'is',value:'on'}]});
  f.states.push(sensor('switch.computer','on',{last_reported:new Date(now-86400000).toISOString(),attributes:{friendly_name:'Office computer'}}));
  let room=evaluateHeating(f).rooms[0];assert.equal(room.occupied,true);assert.equal(room.target,21);assert.deepEqual(room.presence.active,['Office computer']);
  f.states.at(-1).state='off';f.now=now+5*60000;room=evaluateHeating(f).rooms[0];assert.equal(room.occupied,true);assert.equal(room.presence.held,true);
  f.now=now+21*60000;room=evaluateHeating(f).rooms[0];assert.equal(room.occupied,false);assert.equal(room.target,16);
});

test('numeric device clues require fresh reports and unavailable presence retains comfort',()=>{
  const f=fixture();f.rules=[];
  Object.assign(f.rooms[0],{presenceMode:'comfort',presenceHoldMinutes:0,presenceRules:[{entityId:'sensor.pc_power',condition:'above',value:40}]});
  f.states.push(sensor('sensor.pc_power',80,{attributes:{unit_of_measurement:'W'}}));
  assert.equal(evaluateHeating(f).rooms[0].occupied,true);
  f.states.at(-1).state='5';assert.equal(evaluateHeating(f).rooms[0].target,16);
  f.states.at(-1).last_reported=new Date(now-3600000).toISOString();let room=evaluateHeating(f).rooms[0];assert.equal(room.occupied,false);assert.equal(room.target,21);assert.match(room.reason,/unavailable/);
  f.states.at(-1).last_reported=new Date(now+3600000).toISOString();assert.equal(evaluateHeating(f).rooms[0].presence.unknown,true);
});

test('schedules and Away override presence targets; changing clues clears previous holds',()=>{
  const f=fixture();f.presenceMemory=new Map();Object.assign(f.rooms[0],{presenceMode:'comfort',presenceHoldMinutes:20,presenceRules:[{entityId:'media_player.office',condition:'is',value:'playing'}]});
  f.states.push(sensor('media_player.office','playing'));assert.equal(evaluateHeating(f).rooms[0].target,21);
  f.config.heating.activity='away';assert.equal(evaluateHeating(f).rooms[0].target,16);
  f.config.heating.activity='home';f.rules=[];f.rooms[0].presenceRules[0].value='on';
  const room=evaluateHeating(f).rooms[0];assert.equal(room.occupied,false);assert.equal(room.target,16);
});

test('radiator mappings retain preview targets when a valve becomes unavailable',()=>{
  const f=fixture();f.rooms[0].radiatorEntity='climate.office_valve';f.states.push(sensor('climate.office_valve','heat',{attributes:{temperature:19,temperature_unit:'°C',friendly_name:'Office radiator'}}));
  let valve=evaluateHeating(f).rooms[0].radiator;assert.equal(valve.available,true);assert.equal(valve.currentTarget,19);assert.equal(valve.target,21);assert.equal(valve.preview,true);
  f.states.at(-1).state='unavailable';valve=evaluateHeating(f).rooms[0].radiator;assert.equal(valve.available,false);assert.equal(valve.entityId,'climate.office_valve');assert.equal(valve.currentTarget,null);
});
