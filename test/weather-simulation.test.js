import test from 'node:test';
import assert from 'node:assert/strict';
import {heatingScenario,flowCurve,weatherSimulationMarkup} from '../public/weather-simulation.js';
import {defaultWeatherPlan,defaultRoomControl} from '../public/heating-model.js';
import {evaluateHeating} from '../server/modules/heating.js';
import {valvePlan} from '../server/modules/thermostat.js';
import {defaults} from '../server/defaults.js';

const weather={...defaultWeatherPlan,enabled:true,taperBand:1};
const options={weather,target:20,inside:18,outside:8};

test('the graph follows the controller through room correction, taper, early stop and frost',()=>{
 const now=Date.parse('2026-11-06T12:00:00Z'),stamp=new Date(now).toISOString();
 const room={id:'kitchen',name:'Kitchen',sensorEntities:['sensor.kitchen'],comfort:20,eco:16,weight:1,targetOffset:0,awayOffset:0,heatControl:{...defaultRoomControl,startBelow:.4,stopBelow:.2}};
 const config=structuredClone(defaults);config.heatingPlan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);config.heatingPlan.activities.find(p=>p.id==='home').rooms={kitchen:{priority:'high',offset:0}};
 for(const enabled of [true,false])for(const taperBand of [0,1,3])for(const outside of [-10,8,20])for(const inside of [6.9,17,19.5,19.7,19.85,20,21]){
  const settings={...weather,entityId:'weather.home',enabled,taperBand};config.heatingPlan.weather=settings;
  const memory=new Map();
  const evaluate=value=>evaluateHeating({rooms:[room],rules:[],config,now,demandMemory:memory,states:[{entity_id:'sensor.kitchen',state:String(value),attributes:{unit_of_measurement:'°C'},last_reported:stamp},{entity_id:'weather.home',state:'cloudy',attributes:{temperature:outside,temperature_unit:'°C'},last_reported:stamp}]});
  evaluate(15);const data=evaluate(inside),scenario=heatingScenario({weather:settings,target:20,inside,outside,room});
  assert.equal(scenario.flowC,data.smartPlan.flowC,JSON.stringify({enabled,taperBand,outside,inside}));
  assert.equal(scenario.opening,valvePlan(data.rooms[0]).opening);
 }
});

test('outside and target temperatures change the curve, and taper progressively reaches the minimum then off',()=>{
 assert.ok(heatingScenario({...options,outside:-5}).flowC>heatingScenario({...options,outside:15}).flowC);
 assert.ok(heatingScenario({...options,target:22,inside:19.5}).flowC>heatingScenario({...options,inside:19.5}).flowC);
 const flows=[18,19,19.5,19.8,19.95,20,20.5].map(inside=>heatingScenario({...options,inside}).flowC);
 assert.ok(flows.every((flow,i)=>i===0||flow<=flows[i-1]));assert.equal(flows.at(-1),0);
 assert.ok(heatingScenario({...options,inside:19.9999}).flowC>=weather.minFlow);
 assert.equal(heatingScenario({...options,inside:20}).flowC,0);
});

test('weather disabled, fixed opening and room early-stop settings use the same preview logic',()=>{
 const disabled={...weather,enabled:false};assert.equal(heatingScenario({...options,weather:disabled,outside:-10}).flowC,heatingScenario({...options,weather:disabled,outside:25}).flowC);
 const room={heatControl:{...defaultRoomControl,stopBelow:.2,startBelow:.4,openingMode:'fixed',fixedOpening:35}};
 assert.equal(heatingScenario({...options,room}).opening,35);
 assert.equal(heatingScenario({...options,room,inside:19.85}).flowC,0);
 assert.equal(heatingScenario({...options,room,inside:19.7,warming:true}).calling,true);
 assert.equal(heatingScenario({...options,room,inside:19.7,warming:false}).calling,false);
});

test('selected room sunshine allowance is bounded by frost protection and shown in the stopping point',()=>{
 const room={sunCompensation:{reductionC:1}};
 const sunny=heatingScenario({...options,room});assert.equal(sunny.stopC,19);assert.equal(sunny.sunReduction,1);assert.ok(sunny.flowC<heatingScenario(options).flowC);
 assert.equal(heatingScenario({...options,room,inside:19}).calling,false);
 const frost=heatingScenario({...options,room,inside:6.9});assert.equal(frost.sunReduction,0);assert.equal(frost.calling,true);assert.ok(frost.flowC<=40);
 assert.equal(heatingScenario({...options,target:7,room}).stopC,7);
});

test('curve samples include switching boundaries, stay ordered and never draw a ramp below minimum flow',()=>{
 for(const target of [7,18,28])for(const inside of [5,18,30]){
  const curve=flowCurve({...options,target,inside});assert.ok(curve.min<curve.max);assert.ok(curve.min<=inside&&curve.max>=inside);
  assert.ok(curve.points.every((p,i)=>p.flowC===0||p.flowC>=weather.minFlow&&p.flowC<=weather.maxFlow));
  assert.ok(curve.points.every((p,i)=>i===0||p.inside>curve.points[i-1].inside));
  const lastHeating=curve.points.filter(p=>p.calling).at(-1),firstOff=curve.points.find(p=>!p.calling);
  if(lastHeating&&firstOff)assert.ok(firstOff.inside-lastHeating.inside<.0001);
 }
});

test('simulator has three accessible sliders, room choice and a preview-only reset with escaped room names',()=>{
 const html=weatherSimulationMarkup([{id:'bad"id',name:'<Kitchen>'}]);assert.equal((html.match(/type="range"/g)||[]).length,3);
 assert.match(html,/Outside temperature/);assert.match(html,/Room temperature/);assert.match(html,/Target temperature/);assert.match(html,/type="button"[^>]*data-model-reset/);
 assert.match(html,/Preview temperatures are for exploring only/);assert.match(html,/&lt;Kitchen&gt;/);assert.match(html,/bad&quot;id/);assert.doesNotMatch(html,/<Kitchen>|<table/);
});
