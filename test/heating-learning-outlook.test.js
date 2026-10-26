import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {warmupInsights,createHeatingHistory} from '../server/modules/heating-history.js';
import {predictWarmup} from '../server/modules/heating-learning.js';
import {buildHeatingOutlook,forecastAt} from '../server/modules/heating-outlook.js';
import {createStore} from '../server/db.js';
import {defaultHeatingPlan} from '../server/heating-plan.js';
import {defaultWeatherPlan,smartThermostatPlan} from '../server/smart-thermostat.js';
import {validateHeatingPlan} from '../server/validate.js';
import {analysisMarkup} from '../public/modules/heating-analysis.js';

const now=Date.parse('2026-10-23T05:00:00Z'),sensorFingerprint='["sensor.office"]';
const room={id:'office',name:'Office',comfort:20,eco:16,targetOffset:0,awayOffset:0,fresh:true,current:18,sensorFingerprint,radiatorEntity:''};
function samples(start,outside,flow=52,rise=2){return Array.from({length:41},(_,minute)=>({at:new Date(start+minute*60000).toISOString(),heating:true,boiler:{outdoor_c:outside,outdoor_entity:'weather.home',outdoor_kind:'reported',flow_c:flow,modulation_pct:30},rooms:[{id:'office',current:18+rise*minute/40,target:20,sourceAt:new Date(start+minute*60000).toISOString(),sensorFingerprint}]}));}
function settings(){const plan=structuredClone(defaultHeatingPlan);plan.weather={...defaultWeatherPlan,enabled:true,entityId:'weather.home'};plan.activities=[{id:'low',name:'Setback',targetMode:'house',offset:0,rooms:{office:{offset:0,priority:'low'}}},{id:'high',name:'Comfort',targetMode:'house',offset:0,rooms:{office:{offset:0,priority:'high'}}}];plan.timeline=Array.from({length:7},()=>[{start:0,activityId:'low'},{start:420,activityId:'high'}]);plan.awayTimeline=Array.from({length:7},()=>[{start:0,activityId:'low'}]);return plan;}
function evidence(){const rows=[...samples(now-4*86400000,10),...samples(now-3*86400000,9),...samples(now-2*86400000,11)];return warmupInsights(rows,[room],now);}
function forecast(){return {enabled:true,configured:true,connected:true,entityId:'weather.home',hourly:{fresh:true,points:Array.from({length:49},(_,hour)=>({at:new Date(now+hour*3600000).toISOString(),temperatureC:10,condition:'cloudy'}))},daily:{fresh:true,points:Array.from({length:7},(_,day)=>({at:new Date(now+day*86400000).toISOString(),temperatureC:15,lowC:5,condition:'cloudy'}))}};}
function outlook(custom={}){return buildHeatingOutlook({data:{rooms:[room],plan:{occupancy:{effective:'home'}}},settings:settings(),forecasts:forecast(),learning:{rooms:evidence()},timezone:'Europe/London',now,...custom});}

test('warm-up evidence pairs reported outside and actual flow, captures first target reach and records active progress',()=>{
 const rows=samples(now,10),result=warmupInsights(rows,[room],now+40*60000)[0];assert.equal(result.sessions,1);assert.equal(result.minutesPerC,20);assert.equal(result.latest[0].meanOutdoorC,10);assert.equal(result.latest[0].meanFlowC,52);assert.equal(result.latest[0].weatherCoverage,1);assert.equal(result.latest[0].minutesToTarget,36);assert.equal(result.active.sourceReadings,41);assert.equal(result.active.minutes,40);assert.equal(result.weather.matchedSessions,0);assert.equal(result.diagnostics.weatherMatchedSamples,41);
 const completed=warmupInsights(rows,[room],now+50*60000)[0];assert.equal(completed.weather.matchedSessions,1);assert.equal(completed.active,null);
});
test('forecast-looking or unidentified outdoor values never become observed weather evidence',()=>{
 for(const change of [s=>s.boiler.outdoor_kind='forecast',s=>delete s.boiler.outdoor_entity]){const rows=samples(now,10);rows.forEach(change);const result=warmupInsights(rows,[room],now+3600000)[0];assert.equal(result.sessions,1);assert.equal(result.weather.matchedSessions,0);assert.equal(result.latest[0].meanOutdoorC,null);}
});
test('weather-source changes split sessions and limited outside coverage cannot train readiness estimates',()=>{
 const rows=samples(now,10);rows.forEach((s,i)=>{if(i>=20)s.boiler.outdoor_entity='sensor.outside';});assert.equal(warmupInsights(rows,[room],now+3600000)[0].sessions,2);
 const incomplete=samples(now,10);incomplete.forEach((s,i)=>{if(i>10)s.boiler.outdoor_c=null;});assert.equal(warmupInsights(incomplete,[room],now+3600000)[0].weather.matchedSessions,0);
});
test('weather bands and correlation describe actual observations and require varied evidence',()=>{
 const rows=[...samples(now-4*86400000,0,52,1),...samples(now-3*86400000,5,52,1.5),...samples(now-2*86400000,10,52,2)];const result=warmupInsights(rows,[room],now)[0];assert.equal(result.weather.matchedSessions,3);assert.equal(result.weather.bands.length,3);assert.ok(result.weather.correlation<-.9);assert.deepEqual(result.weather.outdoorRange,[0,10]);assert.equal(result.weather.bands[0].meanFlowC,52);assert.equal(evidence()[0].weather.correlation,null);
});
test('readiness learning requires three completed comparable periods on two days, matching sensors, valve and actual flow',()=>{
 const insight=evidence()[0],prediction=predictWarmup(insight,room,10,52,'weather.home');assert.equal(prediction.minutesPerC,20);assert.equal(prediction.sessions,3);assert.equal(prediction.confidence,'early');
 assert.equal(predictWarmup({...insight,evidence:insight.evidence.slice(0,2)},room,10,52),null);
 for(const other of [{...room,fresh:false},{...room,current:12},{...room,sensorFingerprint:'changed'},{...room,radiatorEntity:'climate.new'}])assert.equal(predictWarmup(insight,other,10,52),null);
 assert.equal(predictWarmup(insight,room,-10,52),null);assert.equal(predictWarmup(insight,room,10,40),null);assert.equal(predictWarmup(insight,room,10,52,'sensor.other'),null);assert.equal(predictWarmup({...insight,evidence:insight.evidence.map(s=>({...s,ongoing:true}))},room,10,52),null);
 const sameDay={...insight,evidence:insight.evidence.map(s=>({...s,start:'2026-10-20T12:00:00Z'}))};assert.equal(predictWarmup(sameDay,room,10,52),null);
});
test('forecast lookup interpolates only between adjacent hourly points and never extends across gaps or daily data',()=>{
 const points=forecast().hourly.points;points[1].temperatureC=8;assert.equal(forecastAt(points,now+30*60000),9);assert.equal(forecastAt([points[0],points[2]],now+3600000),null);assert.equal(forecastAt(points,now-60000),null);assert.equal(forecastAt(points,now+60*3600000),null);
});
test('hourly and daily schedule scenarios remain separate and evidence drives a bounded indicative preheat start',()=>{
 const result=outlook(),start=result.scenarios.home.readiness[0];assert.equal(result.planningOnly,true);assert.equal(start.readyAt,'2026-10-23T06:00:00.000Z');assert.equal(start.minutes,40);assert.equal(start.startBy,'2026-10-23T05:20:00.000Z');assert.equal(start.status,'estimated');assert.equal(result.scenarios.away.readiness.length,0);assert.equal(result.scenarios.home.daily.length,7);assert.equal(result.scenarios.home.daily[0].roomHours[0].hours,17);assert.equal(result.scenarios.away.daily[0].roomHours[0].hours,0);assert.ok(result.scenarios.home.daily[0].flowLowC<=result.scenarios.home.daily[0].flowHighC);assert.match(result.assumption,/not predictions of future occupancy/);
});
test('missing or stale forecasts and insufficient observations withhold estimates instead of using today’s temperature as a forecast',()=>{
 const f=forecast();f.hourly.fresh=false;let result=outlook({forecasts:f});assert.equal(result.scenarios.home.hourly.length,0);assert.equal(result.scenarios.home.daily.length,7);assert.equal(result.scenarios.home.readiness[0].status,'forecast_unavailable');assert.equal(result.scenarios.home.readiness[0].startBy,null);
 result=outlook({learning:{rooms:[]}});assert.equal(result.scenarios.home.readiness[0].status,'learning');assert.equal(result.scenarios.home.readiness[0].minutes,null);
 const p=settings();p.weather.maxPreheatMinutes=15;result=outlook({settings:p});assert.equal(result.scenarios.home.readiness[0].status,'over_limit');assert.equal(result.scenarios.home.readiness[0].startBy,null);
});
test('future cooling is not invented for satisfied or unavailable rooms; negative room offsets keep the flow guide consistent',()=>{
 let result=outlook({data:{rooms:[{...room,current:21}],plan:{occupancy:{effective:'home'}}}});assert.equal(result.scenarios.home.readiness[0].status,'at_target_now');assert.equal(result.scenarios.home.readiness[0].startBy,null);
 result=outlook({data:{rooms:[{...room,current:null,fresh:false}],plan:{occupancy:{effective:'home'}}}});assert.equal(result.scenarios.home.readiness[0].status,'room_unavailable');
 const lowRoom={...room,targetOffset:-8,awayOffset:-10};result=outlook({data:{rooms:[lowRoom],plan:{occupancy:{effective:'home'}}}});assert.equal(result.scenarios.away.hourly[0].rooms[0].targetC,7);assert.equal(result.scenarios.away.hourly[0].flowGuideC,35);
});
test('UK clock changes use local schedule time for readiness and keep timestamp offsets explicit',()=>{
 const at=Date.parse('2026-10-25T00:00:00Z'),p=settings();p.timeline[6]=[{start:0,activityId:'low'},{start:150,activityId:'high'}];const result=outlook({now:at,settings:p,forecasts:{...forecast(),hourly:{fresh:false,points:[]}}});assert.equal(result.scenarios.home.readiness[0].readyAt,'2026-10-25T02:30:00.000Z');
});
test('current outside reports are retained for observation even when weather-based flow planning is disabled',()=>{
 const p=settings();p.weather.enabled=false;const data=smartThermostatPlan([{...room,priority:'high',target:20,deficit:2,callingForHeat:true}],p,[{entity_id:'weather.home',state:'cloudy',last_reported:new Date(now).toISOString(),attributes:{temperature:5,temperature_unit:'°C'}}],now);assert.equal(data.weather.status,'disabled');assert.equal(data.weather.outdoor.temperature,5);assert.equal(data.weather.baseFlowC,35);
});
test('minute collection retains source provenance and actual CH flow during flame-off circulation without creating forecasts as measurements',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-learning-')),store=createStore(directory);
 try{
  const p=settings(),data={plan:{settings:p,profile:{name:'Comfort'},occupancy:{effective:'home'}},rooms:[{...room,target:20,sourceAt:new Date(now).toISOString()}],smartPlan:{kind:'comfort',flowC:50,reason:'Test',weather:{status:'current',outdoor:{temperature:10,at:new Date(now).toISOString(),entityId:'weather.home'}}}};
  const history=createHeatingHistory({store,boiler:{status:()=>({connected:true,telemetry:{heating_sample_valid:true,ch_active:true,dhw_active:false,boiler_fault:false,flame:false,opentherm_age_s:2,ch_flow_c:45,ch_return_c:35,modulation_pct:0}})}},()=>data);history.capture(now);history.capture(now+10000);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM heating_samples').get().n,1);const value=JSON.parse(store.db.prepare('SELECT snapshot FROM heating_samples').get().snapshot);assert.equal(value.heating,true);assert.equal(value.boiler.flow_c,45);assert.equal(value.boiler.outdoor_kind,'reported');assert.equal(history.insights(now).rooms.some(r=>Object.hasOwn(r,'evidence')),false);
 }finally{store.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('cold-learning-'));rmSync(absolute,{recursive:true,force:true});}
});
test('weather settings validate the forecast entity and bound the preparation window',()=>{
 const p=settings();assert.equal(validateHeatingPlan(p).weather.maxPreheatMinutes,180);for(const change of [p=>p.weather.forecastEntityId='climate.boiler',p=>p.weather.maxPreheatMinutes=1000]){const value=structuredClone(p);change(value);assert.throws(()=>validateHeatingPlan(value),e=>e.status===400);}
});
test('large-dialog markup keeps observations separate from forecasts and explains collection, evidence and planning limits',()=>{
 const rooms=evidence(),data={days:30,samples:123,rooms,outlook:outlook()},state={tab:'learning',scenario:'home',roomId:'office'};const learning=analysisMarkup(data,state,'Europe/London');assert.match(learning,/Distinct source readings/);assert.match(learning,/Outdoor coverage/);assert.match(learning,/never forecast values/);assert.match(learning,/analysis-learning-chart/);assert.doesNotMatch(learning,/analysis-forecast-chart/);
 const ahead=analysisMarkup(data,{...state,tab:'forecast'},'Europe/London');assert.match(ahead,/Seven-day outlook/);assert.match(ahead,/Indicative start by/);assert.match(ahead,/analysis-forecast-chart/);assert.match(ahead,/6:20 am/);assert.match(ahead,/no heating or radiator commands/);
});
