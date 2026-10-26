import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createApplication} from '../server/app.js';
import {createStore} from '../server/db.js';
import {signedMessage} from '../server/modules/boiler.js';
import {valvePlan} from '../server/modules/thermostat.js';
import {exchangeHealth} from '../server/modules/exchange-health.js';
import {trvzbContext,prepareTrvzb} from '../server/integrations/trvzb.js';
import {thermostatMarkup} from '../public/modules/thermostat-controls.js';
import {evaluateHeating,heatingSummary} from '../server/modules/heating.js';
import {defaults} from '../server/defaults.js';

function remove(directory){const p=resolve(directory);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('cold-active-'));rmSync(p,{recursive:true,force:true});}
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'cold-active-')),now=Date.now(),stamp=new Date(now).toISOString(),writes=[];
 const state=(entity_id,state,attributes={})=>({entity_id,state,attributes,last_reported:stamp});
 const states=[state('sensor.office','18',{unit_of_measurement:'°C'}),state('sensor.kitchen','24',{unit_of_measurement:'°C'}),state('climate.kitchen','heat',{current_temperature:24,temperature:20,temperature_unit:'°C',min_temp:4,max_temp:35,target_temp_step:.5,hvac_modes:['heat','auto','off'],supported_features:1}),state('number.open','100',{min:0,max:100,step:1}),state('number.close','100',{min:0,max:100,step:1}),state('switch.adaptive','on')];
 const entry=(entity_id,original_name)=>({entity_id,original_name,platform:'zha',device_id:'kitchen-device',disabled_by:null});
 const registry=[entry('climate.kitchen','Kitchen TRV'),entry('number.open','Valve opening degree'),entry('number.close','Valve closing degree'),entry('switch.adaptive','Adaptive mode')];
 let hook=null,fail=false;
 const app=createApplication({dataDir:directory,haRegistryRequest:async()=>structuredClone(registry),haRequest:async(url,options={})=>{
  if(url.endsWith('/states'))return structuredClone(states);
  if(options.method==='POST'){
   const body=JSON.parse(options.body);writes.push({url,body});if(hook)await hook(url,body);if(fail)throw new Error('Private fixture error');
   const target=states.find(s=>s.entity_id===body.entity_id);if(!target)throw new Error('Unexpected entity');
   if(url.endsWith('/number/set_value'))target.state=String(body.value);
   else if(url.endsWith('/switch/turn_off'))target.state='off';
   else if(url.endsWith('/climate/set_temperature')){target.state=body.hvac_mode;target.attributes.temperature=body.temperature;}
   else throw new Error('Unexpected service');
   return [];
  }
  return {};
 }});
 const {store}=app.context;
 for(const room of store.list('rooms'))store.remove('rooms',room.id);
 store.put('rooms',{id:'office',name:'Office',sensorEntities:['sensor.office'],comfort:20,eco:16,weight:1,targetOffset:0,awayOffset:0});
 store.put('rooms',{id:'kitchen',name:'Kitchen',sensorEntities:['sensor.kitchen'],radiatorEntity:'climate.kitchen',comfort:20,eco:16,weight:1,targetOffset:0,awayOffset:0});
 const plan=store.config().heatingPlan;plan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);plan.activities.find(p=>p.id==='home').rooms={office:{offset:0,priority:'high'},kitchen:{offset:0,priority:'low'}};store.save('heatingPlan',plan);
 store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','fixture-token');
 const pair=app.context.boiler.pair();let sequence=0;
 const telemetry={protocol_revision:2,min_flow_c:35,max_flow_c:52,comfort_enabled:true,boiler_fault:false,opentherm_age_s:1,pid_available:true,flow_c:40,remote_active:false,exchange_failures:0};
 const exchange=(extra={},at=now)=>JSON.parse(app.context.boiler.exchange(signedMessage({v:1,device_id:pair.deviceId,boot_id:'a'.repeat(32),request_id:(++sequence).toString(16).padStart(16,'0'),sequence,mode:'Cold Harbour',telemetry,...extra},pair.key),at).payload);
 t.after(async()=>{await app.close();remove(directory);});
 return {app,directory,now,states,registry,writes,store,exchange,telemetry,setHook(value){hook=value;},setFail(value){fail=value;}};
}

test('Planning is the upgrade default and sends no TRV writes or remote boiler leases',async t=>{
 const f=fixture(t);assert.equal(f.store.config().thermostat.mode,'planning');await f.app.tick();
 const reply=f.exchange();assert.equal(reply.authority,'pid');assert.equal(reply.lease_s,0);assert.equal(f.writes.length,0);
 const status=f.app.context.thermostat.status();assert.equal(status.mode,'planning');assert.equal(status.valves[0].opening,0);
});

test('Active prepares the sunny kitchen before granting bounded boiler heat for the cold office',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');
 let reply=f.app.context.thermostat.response(heatingSummary(f.app.context),{connected:true,selectedMode:'Cold Harbour',telemetry:f.telemetry},f.now);
 assert.equal(reply.authority,'remote');assert.equal(reply.enabled,false);assert.equal(reply.flow_c,0);
 await f.app.context.thermostat.sync();assert.deepEqual(f.writes.map(w=>[w.url.split('/services/')[1],w.body]),[
  ['switch/turn_off',{entity_id:'switch.adaptive'}],['number/set_value',{entity_id:'number.open',value:0}],['climate/set_temperature',{entity_id:'climate.kitchen',temperature:16,hvac_mode:'heat'}]
 ]);
 assert.equal(f.app.context.thermostat.status().canGrant,false,'HTTP success is not a reported setting');
 await f.app.context.ha.poll();assert.equal(f.app.context.thermostat.status().canGrant,true);
 reply=f.exchange({},f.now+30000);assert.equal(reply.authority,'remote');assert.equal(reply.enabled,true);assert.ok(reply.flow_c>=35&&reply.flow_c<=52);assert.equal(reply.lease_s,90);
 assert.match(reply.reason,/Office/);await f.app.context.thermostat.sync();assert.equal(f.writes.length,3);
});

test('Active regulates a cold smart room with a separate bounded actuator target and closes it when satisfied',async t=>{
 const f=fixture(t);f.states[1].state='15';f.states[2].attributes.current_temperature=15;await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');
 assert.equal(f.app.context.thermostat.status().valves[0].opening,50);assert.equal(f.app.context.thermostat.status().valves[0].roomTarget,16);assert.equal(f.app.context.thermostat.status().valves[0].deviceTarget,19);
 await f.app.context.thermostat.sync();assert.ok(f.writes.some(w=>w.body.value===50));assert.ok(f.writes.some(w=>w.body.temperature===19));
 assert.ok(f.writes.every(w=>!w.url.includes('external_temperature')));
 assert.equal(valvePlan({fresh:true,callingForHeat:true,deficit:10,target:28,current:18,radiator:{currentTemperature:40}}).deviceTarget,33);
});

test('ESP Local PID overrides Active and never permits app radiator writes',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange({mode:'PID'});await f.app.context.thermostat.setMode('active');await f.app.context.thermostat.sync();
 assert.equal(f.writes.length,0);assert.equal(f.app.context.thermostat.status().ready,false);assert.equal(f.exchange({mode:'PID'},f.now+30000).authority,'pid');
});

test('Planning releases the next lease and leaves existing radiator settings unchanged',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');await f.app.context.thermostat.sync();await f.app.context.ha.poll();
 assert.equal(f.exchange({},f.now+30000).authority,'remote');const count=f.writes.length;
 await f.app.context.thermostat.setMode('planning');await f.app.context.thermostat.sync();const reply=f.exchange({},f.now+60000);assert.equal(reply.authority,'pid');assert.equal(reply.lease_s,0);assert.equal(f.writes.length,count);assert.equal(f.states.find(s=>s.entity_id==='number.open').state,'0');
});

test('missing controls, fresh feedback, ESP limits, comfort permission or HA connection withhold Active authority',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');const data=heatingSummary(f.app.context);
 for(const override of [{boiler_fault:true},{opentherm_age_s:90},{comfort_enabled:false},{min_flow_c:undefined},{protocol_revision:1}]){
  const reply=f.app.context.thermostat.response(data,{connected:true,selectedMode:'Cold Harbour',telemetry:{...f.telemetry,...override}},f.now);assert.equal(reply.authority,'pid');
 }
 assert.equal(f.app.context.thermostat.status(f.now+91000).ready,false);
 f.app.context.ha.invalidate();await f.app.context.thermostat.sync();assert.equal(f.writes.length,0);
});

test('ZHA valve controls require unambiguous enabled entities on the same registered device',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();const room=heatingSummary(f.app.context).rooms[1],plan=valvePlan(room);
 const prepare=registry=>prepareTrvzb(room,plan,trvzbContext(room.radiatorEntity,{states:f.states,registry,fresh:true,registryFresh:true,temperatureUnit:'°C'}));
 assert.equal(prepare(f.registry).ready,true);
 for(const mutate of [r=>r[1].disabled_by='user',r=>r[1].device_id='other',r=>r[0].platform='esphome',r=>r.push({...r[1],entity_id:'number.duplicate'}),r=>r.splice(3,1)]){const entries=structuredClone(f.registry);mutate(entries);assert.equal(prepare(entries).ready,false);}
});

test('switching to Planning during an in-flight command prevents subsequent valve writes',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');
 f.setHook(async()=>{await f.app.context.thermostat.setMode('planning');});await f.app.context.thermostat.sync();assert.equal(f.writes.length,1);assert.equal(f.app.context.thermostat.status().active,false);
});

test('importing configuration during an in-flight command cancels subsequent writes and requires fresh readings',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');
 await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${f.app.server.address().port}`;
 const post=async(path,body)=>{const response=await fetch(base+'/api/backups/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
 const password='fixture backup password',backup=await post('export',{password}),preview=await post('preview',{backup,password});
 f.setHook(async()=>{await post('import',{backup,password,previewId:preview.previewId,confirm:true});});
 await f.app.context.thermostat.sync();assert.equal(f.writes.length,1);assert.equal(f.store.config().thermostat.mode,'planning');assert.equal(f.app.context.ha.status.connected,false);assert.equal(f.app.context.boiler.status().connected,false);
 await f.app.context.thermostat.sync();assert.equal(f.writes.length,1);assert.equal(f.exchange({},f.now+30000).authority,'pid');
});

test('failed commands stay visible, hold boiler heat and are not retried on every poll',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');f.setFail(true);await f.app.context.thermostat.sync();
 let status=f.app.context.thermostat.status();assert.equal(status.state,'valve-error');assert.ok(!JSON.stringify(status).includes('Private fixture'));const n=f.writes.length;
 await f.app.context.thermostat.sync();assert.equal(f.writes.length,n);
 const reply=f.app.context.thermostat.response(heatingSummary(f.app.context),{connected:true,selectedMode:'Cold Harbour',telemetry:f.telemetry},f.now);assert.equal(reply.authority,'remote');assert.equal(reply.enabled,false);
});

test('weather flow is clamped to current ESP limits and satisfied rooms receive a remote off lease',async t=>{
 const f=fixture(t);f.store.put('rooms',{...f.store.list('rooms')[1],radiatorEntity:''});await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');
 const data=heatingSummary(f.app.context);data.smartPlan.flowC=75;
 let reply=f.app.context.thermostat.response(data,{connected:true,selectedMode:'Cold Harbour',telemetry:f.telemetry},f.now);assert.equal(reply.flow_c,52);
 data.smartPlan.heat=false;reply=f.app.context.thermostat.response(data,{connected:true,selectedMode:'Cold Harbour',telemetry:f.telemetry},f.now);assert.equal(reply.authority,'remote');assert.equal(reply.enabled,false);assert.equal(reply.flow_c,0);assert.equal(reply.lease_s,90);
});

test('mode API accepts only a mode, does not accept arbitrary targets, and readiness UI explains both modes',async t=>{
 const f=fixture(t);await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${f.app.server.address().port}`;
 const post=body=>fetch(base+'/api/heating/control',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});
 for(const body of [{mode:'active',entityId:'climate.other'},{mode:'active',flow:80},{mode:'unknown'},{}])assert.equal((await post(body)).status,400);
 assert.equal((await post({mode:'active'})).status,200);const data=await (await fetch(base+'/api/heating')).json();assert.equal(data.mode,'active');assert.equal(data.smartPlan.planningOnly,false);assert.equal(data.control.active,true);assert.equal(data.valveControlEnabled,false);
 const html=thermostatMarkup(data.control);assert.match(html,/Planning · monitor and calculate/);assert.match(html,/Active · control boiler and radiators/);assert.match(html,/5°C/);assert.match(html,/no automatic TRV reset/);
 assert.ok(!JSON.stringify(data).includes('fixture-token'));
});

test('selected operation survives restart while new installation defaults to Planning',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-active-'));let store=createStore(directory);
 try{assert.equal(store.config().thermostat.mode,'planning');store.save('thermostat',{mode:'active'});store.close();store=createStore(directory);assert.equal(store.config().thermostat.mode,'active');}
 finally{store.close();remove(directory);}
});

test('room demand hysteresis holds a heat request until target and resets when the target changes',()=>{
 const config=structuredClone(defaults),demandMemory=new Map(),room={id:'kitchen',name:'Kitchen',sensorEntities:['sensor.kitchen'],comfort:20,eco:16,weight:1};
 config.heatingPlan.timeline=Array.from({length:7},()=>[{start:0,activityId:'home'}]);config.heatingPlan.activities.find(p=>p.id==='home').rooms.kitchen={priority:'high',offset:0};
 const read=current=>evaluateHeating({rooms:[room],rules:[],states:[{entity_id:'sensor.kitchen',state:String(current),attributes:{unit_of_measurement:'°C'},last_reported:new Date().toISOString()}],config,demandMemory}).rooms[0].callingForHeat;
 assert.equal(read(19.9),false);assert.equal(read(19.7),true);assert.equal(read(19.9),true);assert.equal(read(20),false);assert.equal(read(19.9),false);
});

test('exchange health separates cumulative totals, newly reported increases, boot resets and unavailable evidence',()=>{
 const now=Date.now(),row=(seconds,failures,boot_id='a')=>({at:new Date(now-seconds*1000).toISOString(),boot_id,failures});
 const result=exchangeHealth([row(1000,4000),row(800,4410),row(770,4412),row(740,0,'b'),row(710,1,'b')],now,[{at:now-1000,status:401,count:3}]);
 assert.equal(result.totalSinceBoot,1);assert.equal(result.reportedFailureIncrease,413);assert.equal(result.accepted,4);assert.equal(result.rejected,3);assert.equal(result.lastRejection,401);assert.equal(result.longestGapSeconds,710);
 assert.equal(exchangeHealth([row(5,4412)],now).reportedFailureIncrease,null);assert.equal(exchangeHealth([],now).totalSinceBoot,null);
});

test('HTTP rejections are diagnosed without exposing request bodies or pairing keys',async t=>{
 const f=fixture(t);await new Promise(resolve=>f.app.deviceServer.listen(0,'127.0.0.1',resolve));const response=await fetch(`http://127.0.0.1:${f.app.deviceServer.address().port}/v1/exchange`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,401);
 const health=f.app.context.boiler.exchangeHealth();assert.equal(health.rejected,1);assert.equal(health.lastRejection,401);assert.equal(health.accepted,0);
});

test('repeated Active selection and changed schedules cannot bypass the per-radiator write interval',async t=>{
 const f=fixture(t);await f.app.context.ha.poll();f.exchange();await f.app.context.thermostat.setMode('active');await f.app.context.thermostat.sync();const count=f.writes.length;
 await f.app.context.thermostat.setMode('active');await f.app.context.thermostat.sync();assert.equal(f.writes.length,count);
 const plan=f.store.config().heatingPlan;plan.awayTarget=17;f.store.save('heatingPlan',plan);await f.app.context.thermostat.sync();assert.equal(f.writes.length,count);
});

test('zero-opening radiator snapshots cannot count solar warming as delivered radiator heat',async t=>{
 const f=fixture(t);f.states.find(s=>s.entity_id==='number.open').state='0';await f.app.context.ha.poll();
 f.exchange({telemetry:{...f.telemetry,ch_active:true,dhw_active:false,thermal_context:'space_heating',heating_sample_valid:true,ch_flow_c:42}});
 f.app.context.heatingHistory.capture(f.now);const snapshot=JSON.parse(f.store.db.prepare('SELECT snapshot FROM heating_samples').get().snapshot),kitchen=snapshot.rooms.find(r=>r.id==='kitchen');
 assert.equal(snapshot.heating,true);assert.equal(kitchen.radiatorReportedOpening,0);assert.equal(kitchen.radiatorPaused,true);assert.equal(kitchen.plannedOpening,0);
 assert.equal(f.app.context.heatingHistory.chart(60,f.now).points[0].valve_kitchen,0);
});

test('capture on existing firmware uses one observation reply before resuming Active leases',async t=>{
 const f=fixture(t);f.store.put('rooms',{...f.store.list('rooms')[1],radiatorEntity:''});await f.app.context.ha.poll();
 const capture={active:false,remaining_s:0,overwritten:0,frames:[],control_supported:true,last_control_id:''};f.exchange({opentherm:capture});await f.app.context.thermostat.setMode('active');
 assert.equal(f.exchange({opentherm:capture},f.now+30000).authority,'remote');await f.app.context.boiler.requestCapture(true,f.now+30000);
 const observed=f.exchange({opentherm:capture},f.now+35000);assert.equal(observed.authority,'observe');assert.equal(observed.lease_s,0);assert.equal(observed.diagnostic_capture.action,'start');
 await f.app.context.ha.poll();const resumed=f.exchange({opentherm:{...capture,active:true,last_control_id:observed.diagnostic_capture.id}},f.now+40000);
 assert.equal(resumed.authority,'remote');assert.equal(resumed.lease_s,90);
});
