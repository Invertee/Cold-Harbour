import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createStore} from '../server/db.js';
import {createGasBudget} from '../server/modules/gas-budget.js';
import {heatingSummary} from '../server/modules/heating.js';
import {valvePlan} from '../server/modules/thermostat.js';
import {energySummary} from '../server/modules/energy.js';
import {gasBudgetMarkup} from '../public/modules/gas-budget.js';

const now=Date.parse('2026-11-10T12:00:00Z');
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'cold-emergency-')),store=createStore(directory);
 t.after(()=>{store.close();const path=resolve(directory);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&basename(path).startsWith('cold-emergency-'));rmSync(path,{recursive:true,force:true});});
 for(const room of store.list('rooms'))store.remove('rooms',room.id);
 for(const id of ['cold','warm'])store.put('rooms',{id,name:id==='cold'?'Cold room':'Warm room',sensorEntities:[`sensor.${id}`],radiatorEntity:`climate.${id}`,comfort:20,eco:7,weight:1,targetOffset:0,awayOffset:0,heatControl:{startBelow:2,stopBelow:1.5}});
 const plan=store.config().heatingPlan;plan.awayTarget=7;plan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);
 plan.activities.find(p=>p.id==='home').rooms={cold:{priority:'low',offset:0},warm:{priority:'high',offset:0}};store.save('heatingPlan',plan);
 store.save('gasBudget',{...store.config().gasBudget,enabled:true,action:'pause',dailyLimit:10,emergencyTempC:10});
 store.save('energy',{...store.config().energy,gasToday:'sensor.gas',gasTodayCost:'sensor.gas_cost'});
 const sensor=(entity_id,value,unit)=>({entity_id,state:String(value),attributes:{unit_of_measurement:unit},last_updated:new Date(now).toISOString(),last_reported:new Date(now).toISOString()});
 const ha={status:{connected:true,fetchedAt:new Date(now).toISOString()},states:[sensor('sensor.cold',10,'°C'),sensor('sensor.warm',15,'°C'),sensor('sensor.gas',11,'kWh'),sensor('sensor.gas_cost',11,'GBP')]};
 const context={store,ha};context.gasBudget=createGasBudget(context);
 return {store,ha,context,read(value){ha.states[0].state=String(value);return heatingSummary(context,now);},settings(next){store.save('gasBudget',{...store.config().gasBudget,...next});}};
}

test('an exhausted budget heats only cold rooms, even above a lower scheduled target, then pauses after recovery',t=>{
 const f=fixture(t);let data=f.read(10);
 assert.equal(data.smartPlan.heat,false,'At the threshold there is no new emergency.');
 data=f.read(9.9);const cold=data.rooms[0],warm=data.rooms[1];
 assert.equal(data.budget.paused,true);assert.equal(data.budget.emergencyOverride,true);assert.equal(data.smartPlan.kind,'frost');assert.equal(data.smartPlan.heat,true);
 assert.equal(data.smartPlan.leadRoomId,'cold');assert.equal(data.controlRoomId,'cold');assert.equal(data.demandingRoomCount,1);
 assert.equal(cold.scheduledTarget,7);assert.equal(cold.target,10.5);assert.equal(cold.heatingTarget,10.5);assert.equal(cold.callingForHeat,true);assert.equal(cold.coasting,false);
 assert.equal(cold.heatControl.stopBelow,0);assert.ok(valvePlan(cold).opening>0);assert.equal(valvePlan(cold).closesAtC,10.5);
 assert.equal(warm.budgetPaused,true);assert.equal(valvePlan(warm).opening,0,'Comfort demand must stay paused.');
 assert.ok(data.smartPlan.flowC>0&&data.smartPlan.flowC<=40);assert.match(data.smartPlan.reason,/10.5°C overrides the gas budget pause/);
 assert.equal(f.read(10.4).smartPlan.heat,true,'Emergency demand is retained while recovering.');
 data=f.read(10.5);assert.equal(data.smartPlan.heat,false);assert.equal(data.smartPlan.kind,'budget');assert.equal(data.smartPlan.leadRoomId,null);assert.equal(valvePlan(data.rooms[0]).opening,0);
 assert.equal(f.read(10.1).smartPlan.heat,false);assert.equal(f.read(9.9).smartPlan.heat,true);
});

test('emergency heating overrides cost limits, manual pauses and unreleased schedule allowance',t=>{
 const f=fixture(t);f.settings({unit:'cost'});assert.equal(f.read(9).budget.emergencyOverride,true);
 f.settings({action:'monitor'});assert.equal(f.read(9).budget.paused,false);
 f.context.gasBudget.pause(now);assert.equal(f.read(9).budget.emergencyOverride,true);assert.equal(f.read(10.5).smartPlan.heat,false);
 f.context.gasBudget.resume(now);f.settings({unit:'kwh',action:'pause',dailyLimit:50});
 const plan=f.store.config().heatingPlan;plan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home',gasShare:0},{start:1080,activityId:'home',gasShare:100}]);f.store.save('heatingPlan',plan);
 const data=f.read(9);assert.equal(data.budget.dailyReached,false);assert.equal(data.budget.allowance.limit,0);assert.equal(data.budget.emergencyOverride,true);
});

test('missing, stale and invalid room readings cannot initiate or retain an emergency',t=>{
 const f=fixture(t);
 for(const value of ['unavailable','unknown','',NaN]){assert.equal(f.read(9).smartPlan.heat,true);const data=f.read(value);assert.equal(data.budget.emergencyOverride,undefined);assert.equal(data.smartPlan.heat,false);}
 f.read(9);f.ha.states[0].last_reported=new Date(now-86400000).toISOString();assert.equal(f.read(9).smartPlan.heat,false);
 f.ha.states[0].last_reported=new Date(now+120000).toISOString();assert.equal(f.read(9).smartPlan.heat,false);
 f.ha.states[0].last_reported=new Date(now).toISOString();f.read(9);f.ha.status.connected=false;assert.equal(f.read(9).smartPlan.heat,false);
 f.ha.status.connected=true;assert.equal(f.read(10.1).smartPlan.heat,false,'Lost readings clear the recovery latch.');
});

test('emergency recovery resets when the threshold or room sensor mapping changes',t=>{
 const f=fixture(t);f.read(9);f.settings({emergencyTempC:9.5});assert.equal(f.read(9.8).smartPlan.heat,false);
 f.settings({emergencyTempC:10});f.read(9);
 f.ha.states.push({...f.ha.states[0],entity_id:'sensor.replacement',state:'10.1'});
 const room=f.store.list('rooms')[0];f.store.put('rooms',{...room,sensorEntities:['sensor.replacement']});assert.equal(f.read(9).smartPlan.heat,false);
 f.store.put('rooms',room);f.read(9);f.settings({enabled:false});const data=f.read(9);
 assert.equal(data.budget.emergencyOverride,undefined);assert.equal(data.rooms[0].target,7);
 f.settings({enabled:true});assert.equal(f.read(10.1).smartPlan.heat,false);
});

test('sunshine and room coasting cannot suppress emergency recovery',t=>{
 const f=fixture(t),plan=f.store.config().heatingPlan;
 plan.weather={...plan.weather,forecastEntityId:'weather.home'};plan.activities.find(p=>p.id==='home').rooms.cold.priority='high';f.store.save('heatingPlan',plan);
 f.store.put('rooms',{...f.store.list('rooms')[0],sunExposure:100});
 f.ha.states.push({entity_id:'weather.home',state:'sunny',attributes:{},last_reported:new Date(now).toISOString()});
 f.settings({emergencyTempC:19});const data=f.read(18.9);
 assert.equal(data.rooms[0].sunCompensation.reductionC,0);assert.equal(data.rooms[0].heatingTarget,19.5);assert.equal(data.rooms[0].coasting,false);assert.ok(valvePlan(data.rooms[0]).opening>0);
});

test('energy budget status reports the emergency and distinguishes Planning from Active',t=>{
 const f=fixture(t);f.read(9);const data=energySummary(f.context,'today',now).gasBudget;
 assert.equal(data.emergencyOverride,true);assert.equal(data.points.length,0);assert.deepEqual(data.emergencyRoomIds,['cold']);
 assert.match(gasBudgetMarkup(data,true),/Emergency heating/);assert.match(gasBudgetMarkup(data,false),/Emergency heat planned/);
 assert.match(gasBudgetMarkup(data,true),/Cold room is 9.0°C/);
});

test('the emergency floor also heats below a lower schedule when budget is available, while retaining adequate normal heating',t=>{
 const f=fixture(t);f.settings({dailyLimit:50});let data=f.read(9.9);
 assert.equal(data.budget.paused,false);assert.equal(data.budget.emergencyOverride,undefined);
 assert.equal(data.rooms[0].target,10.5);assert.equal(data.rooms[0].emergencyHeating,true);assert.ok(valvePlan(data.rooms[0]).opening>0);
 assert.equal(data.rooms[1].budgetPaused,undefined);assert.ok(valvePlan(data.rooms[1]).opening>0,'Normal comfort heating remains available.');
 assert.doesNotMatch(data.smartPlan.reason,/overrides the gas budget/);
 data=f.read(10.5);assert.equal(data.rooms[0].target,7);assert.equal(valvePlan(data.rooms[0]).opening,0);
 const plan=f.store.config().heatingPlan;plan.activities.find(p=>p.id==='home').rooms.cold.priority='high';f.store.save('heatingPlan',plan);
 data=f.read(9.9);assert.equal(data.rooms[0].target,20);assert.equal(data.rooms[0].emergencyHeating,undefined);assert.equal(data.smartPlan.kind,'comfort');
});
