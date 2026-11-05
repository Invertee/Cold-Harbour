import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults} from '../server/defaults.js';
import {validateRoom,validateHeatingPlan} from '../server/validate.js';
import {evaluateHeating} from '../server/modules/heating.js';
import {valvePlan} from '../server/modules/thermostat.js';
import {defaultWeatherPlan,defaultRoomControl,curveFlow,plannedFlow} from '../public/heating-model.js';
import {roomResponsePreview} from '../public/room-control.js';

const now=Date.parse('2026-11-05T12:00:00Z');
const room={id:'office',name:'Office',sensorEntities:['sensor.office'],comfort:20,eco:16,weight:1,targetOffset:0,awayOffset:0};
function config(){
 const c=structuredClone(defaults);c.heatingPlan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);
 c.heatingPlan.activities.find(p=>p.id==='home').rooms={office:{priority:'high',offset:0}};return c;
}

test('flow offset and curve shape lower starting flow while keeping weather and ESP planning bounds',()=>{
 const w={...defaultWeatherPlan,enabled:true};
 const original=35+17*(20-8)/(20+3);
 assert.equal(curveFlow(20,8,w),original);
 assert.ok(curveFlow(20,8,{...w,flowOffset:-4})<original);
 assert.ok(curveFlow(20,8,{...w,curveExponent:2})<original);
 for(const outside of [-60,-10,0,10,20,40])for(const flowOffset of [-20,20]){
  const flow=curveFlow(20,outside,{...w,flowOffset});assert.ok(flow>=w.minFlow&&flow<=w.maxFlow);
 }
});

test('near-target taper is continuous, respects the minimum and follows each room early stop',()=>{
 const w={...defaultWeatherPlan,taperBand:1,deficitGain:5};
 const flows=[2,1,.5,.2,.05,0].map(deficit=>plannedFlow(47,deficit,w).flowC);
 for(let i=1;i<flows.length;i++)assert.ok(flows[i]<=flows[i-1]);
 assert.equal(flows.at(-1),w.minFlow);
 assert.equal(plannedFlow(47,.2,w,.2).flowC,w.minFlow);
 assert.equal(plannedFlow(47,.5,{...w,taperBand:0}).flowC,49.5);
 assert.ok(plannedFlow(47,.3,w).taperReductionC>0);
});

test('room early stop and reopen use hysteresis without losing frost or missing-sensor behavior',()=>{
 const c=config(),memory=new Map(),r={...room,heatControl:{...defaultRoomControl,startBelow:.4,stopBelow:.2}};
 const at=value=>evaluateHeating({rooms:[r],rules:[],config:c,demandMemory:memory,now,states:[{entity_id:'sensor.office',state:String(value),attributes:{unit_of_measurement:'°C'},last_reported:new Date(now).toISOString()}]});
 assert.equal(at(19.5).rooms[0].callingForHeat,true);
 assert.equal(at(19.7).rooms[0].callingForHeat,true);
 let d=at(19.85);assert.equal(d.rooms[0].callingForHeat,false);assert.equal(d.rooms[0].coasting,true);assert.equal(d.smartPlan.heat,false);
 assert.equal(at(19.7).rooms[0].callingForHeat,false);
 assert.equal(at(19.5).rooms[0].callingForHeat,true);
 d=at('unavailable');assert.equal(d.rooms[0].callingForHeat,false);assert.equal(d.smartPlan.kind,'unavailable');
 d=at(6.9);assert.equal(d.smartPlan.kind,'frost');assert.equal(d.smartPlan.heat,true);
});

test('valve response supports caps and fixed travel, exposes thresholds, and always closes when satisfied',()=>{
 const r={...room,target:20,current:19,deficit:1,fresh:true,callingForHeat:true,heatControl:{...defaultRoomControl,minOpening:15,maxOpening:60,startBelow:.4,stopBelow:.2}};
 let p=valvePlan(r);assert.equal(p.opening,30);assert.equal(p.opensBelowC,19.6);assert.equal(p.closesAtC,19.8);
 assert.equal(valvePlan({...r,deficit:4}).opening,60);
 p=valvePlan({...r,heatControl:{...r.heatControl,openingMode:'fixed',fixedOpening:35}});assert.equal(p.opening,35);
 for(const override of [{fresh:false},{callingForHeat:false},{budgetPaused:true}])assert.equal(valvePlan({...r,...override}).opening,0);
 const html=roomResponsePreview(r);assert.match(html,/19.60°C/);assert.match(html,/19.80°C/);assert.match(html,/30%/);assert.match(html,/already open/);
});

test('room and weather tuning reject inconsistent thresholds and invalid valve travel',()=>{
 assert.deepEqual(validateRoom(room).heatControl,defaultRoomControl);
 for(const change of [{startBelow:.1,stopBelow:.2},{fullOpenBelow:.1,stopBelow:.2},{minOpening:60,maxOpening:50},{fixedOpening:37},{openingMode:'unbounded'},{maxOpening:101},{stopBelow:-1},{magic:1}])assert.throws(()=>validateRoom({...room,heatControl:{...defaultRoomControl,...change}}),e=>e.status===400);
 for(const change of [{flowOffset:21},{curveExponent:0},{taperBand:6},{taperBand:NaN}]){
  const p=config().heatingPlan;p.weather={...p.weather,...change};assert.throws(()=>validateHeatingPlan(p),e=>e.status===400);
 }
 const p=config().heatingPlan;p.weather={...p.weather,flowOffset:-4,curveExponent:1.5,taperBand:1};assert.equal(validateHeatingPlan(p).weather.flowOffset,-4);
});
