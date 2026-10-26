import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,basename,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../server/db.js';
import { createApplication } from '../server/app.js';
import { createBoilerConnection,signedMessage,signPayload } from '../server/modules/boiler.js';
import { decodeFrame } from '../server/modules/opentherm.js';
function remove(dir){const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&/^cold-boiler-/.test(basename(target)));rmSync(target,{recursive:true,force:true});}
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'cold-boiler-')),store=createStore(dir),clock={now:Date.now()};
  t.after(()=>{store.close();remove(dir);});
  for(const room of store.list('rooms'))store.remove('rooms',room.id);
  store.put('rooms',{id:'living',name:'Living room',sensorEntity:'sensor.living',comfort:21,eco:16,weight:1});
  store.put('rooms',{id:'kitchen',name:'Kitchen',sensorEntity:'sensor.kitchen',comfort:20,eco:16,weight:1});
  store.save('heating',{...store.config().heating,activity:'home'});
  const states=[{entity_id:'sensor.living',state:'18',last_reported:new Date(clock.now).toISOString(),attributes:{unit_of_measurement:'°C'}},{entity_id:'sensor.kitchen',state:'27',last_reported:new Date(clock.now).toISOString(),attributes:{unit_of_measurement:'°C'}}];
  const ha={states,get status(){return {connected:true,fetchedAt:new Date(clock.now).toISOString()};},setTemperature:async()=>{throw new Error('Legacy thermostat must not be written');}};
  const context={store,ha},connection=createBoilerConnection(context),key='a'.repeat(64);store.secret('boilerKey',key);
  const payload=(sequence=1,extra={})=>({v:1,device_id:'boiler-controller',boot_id:'b'.repeat(32),request_id:sequence.toString(16).padStart(16,'0'),sequence,mode:'Cold Harbour',telemetry:{flow_c:42,return_c:35,modulation_pct:25,flame:true,free_heap_bytes:100000},...extra});
  const exchange=(sequence=1,extra={})=>{const reply=connection.exchange(signedMessage(payload(sequence,extra),key),clock.now);assert.equal(reply.signature,signPayload(reply.payload,key));return JSON.parse(reply.payload);};
  return {store,clock,states,ha,context,connection,key,payload,exchange};
}

test('listener always releases to PID even with legacy automatic settings and cold rooms',t=>{
  const f=fixture(t);for(const mode of ['Cold Harbour','PID']){
    f.store.save('heating',{...f.store.config().heating,controlTarget:'opentherm',enabled:true});
    const reply=f.exchange(mode==='PID'?2:1,{mode});assert.equal(reply.authority,'pid');assert.equal(reply.enabled,false);assert.equal(reply.flow_c,0);assert.equal(reply.lease_s,0);f.clock.now+=30000;
  }
  assert.equal(f.connection.status(f.clock.now).mode,'listen');assert.equal(f.connection.history()[0].remote_granted,false);assert.equal(f.connection.history()[0].rooms[1].current,27);
});
test('telemetry ingestion works without Home Assistant or mapped rooms',t=>{const f=fixture(t);Object.defineProperty(f.ha,'status',{value:{connected:false}});for(const room of f.store.list('rooms'))f.store.remove('rooms',room.id);assert.equal(f.exchange().authority,'pid');assert.equal(f.connection.status(f.clock.now).telemetry.flow_c,42);});
test('authentication, replay, rate and telemetry checks reject without updating state',t=>{
 const f=fixture(t),message=signedMessage(f.payload(),f.key);
 assert.throws(()=>f.connection.exchange(null,f.clock.now),e=>e.status===401);
 assert.throws(()=>f.connection.exchange({...message,payload:message.payload.replace('42','60')},f.clock.now),e=>e.status===401);assert.equal(f.connection.status().lastSeen,null);f.exchange();
 assert.throws(()=>f.connection.exchange(message,f.clock.now+30000),e=>e.status===409);
 assert.throws(()=>f.connection.exchange(signedMessage(f.payload(2),f.key),f.clock.now+1000),e=>e.status===429);
 assert.throws(()=>f.connection.exchange(signedMessage(f.payload(2,{telemetry:{flow_c:999}}),f.key),f.clock.now+30000),e=>e.status===400);assert.equal(f.connection.status().telemetry.flow_c,42);
});
test('every exchange is logged, minute history deduplicates and key replacement revokes old requests',t=>{
 const f=fixture(t);f.exchange();f.clock.now+=30000;f.exchange(2);f.clock.now+=30000;f.exchange(3);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM boiler_samples').get().n,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM boiler_exchanges').get().n,3);
 const pair=f.connection.pair();assert.match(pair.key,/^[a-f0-9]{64}$/);assert.equal(f.connection.status().connected,false);assert.throws(()=>f.connection.exchange(signedMessage(f.payload(4),f.key),f.clock.now+30000),e=>e.status===401);
});

test('default boiler logs suppress routine readings and limit events after filtering',t=>{
 const f=fixture(t);f.exchange();
 f.clock.now+=30000;f.exchange(2,{telemetry:{...f.payload().telemetry,flame:false}});
 for(let sequence=3;sequence<15;sequence++){f.clock.now+=30000;f.exchange(sequence,{telemetry:{...f.payload().telemetry,flame:false,flow_c:40+sequence/10,return_c:35+sequence/10,modulation_pct:sequence}});}
 const events=f.connection.logs({limit:1});assert.equal(events.kind,'events');assert.equal(events.rows.length,1);
 assert.equal(events.rows[0].sequence,2);assert.match(events.rows[0].summary,/Flame: On → Off/);
 assert.equal(f.connection.logs().rows.length,2);assert.equal(f.connection.logs({kind:'readings'}).rows.length,14);
 assert.equal(f.connection.chart(60,'telemetry',f.clock.now).points.length,14);
});

test('event logs preserve faults, heating phases, restarts and restored connections',t=>{
 const f=fixture(t);f.exchange();f.clock.now+=30000;
 f.exchange(2,{telemetry:{...f.payload().telemetry,boiler_fault:true,ch_active:true,thermal_context:'space_heating'}});
 const event=f.connection.logs().rows[0];assert.match(event.summary,/Boiler fault: Not reported → On/);assert.match(event.summary,/Central heating: Not reported → On/);
 f.clock.now+=120000;f.exchange(1,{boot_id:'c'.repeat(32)});
 assert.match(f.connection.logs().rows[0].summary,/Controller restarted/);assert.match(f.connection.logs().rows[0].summary,/Connection restored/);
});

test('event windows compare against the previous reading rather than inventing a connection',t=>{
 const f=fixture(t),now=Date.now(),insert=f.store.db.prepare('INSERT INTO boiler_exchanges VALUES (?,?,?,?,?,?)');
 const telemetry=JSON.stringify({flame:false,flow_c:40});
 insert.run('boiler-controller','b'.repeat(32),1,new Date(now-3601000).toISOString(),'PID',telemetry);
 insert.run('boiler-controller','b'.repeat(32),2,new Date(now-3590000).toISOString(),'PID',telemetry);
 assert.deepEqual(f.connection.logs({hours:1}).rows,[]);
 insert.run('boiler-controller','b'.repeat(32),3,new Date(now-3580000).toISOString(),'PID',JSON.stringify({flame:true,flow_c:41}));
 assert.equal(f.connection.logs({hours:1}).rows.length,1);assert.match(f.connection.logs({hours:1}).rows[0].summary,/Flame: Off → On/);
});
test('DHW and settling readings cannot enter CH-qualified analysis',t=>{
 const f=fixture(t);for(const [i,extra] of [{dhw_active:true},{dhw_flow_l_min:3},{thermal_context:'settling_after_hot_water'}].entries()){
  f.exchange(i+1,{telemetry:{flow_c:70,ch_flow_c:70,ch_return_c:60,ch_modulation_pct:80,thermal_context:'space_heating',heating_sample_valid:true,ch_active:true,dhw_active:false,opentherm_age_s:2,...extra}});
  assert.equal(f.connection.status(f.clock.now).telemetry.ch_flow_c,undefined);f.clock.now+=30000;
 }
 f.exchange(4,{telemetry:{ch_flow_c:42,thermal_context:'space_heating',heating_sample_valid:true,ch_active:true,dhw_active:false,opentherm_age_s:2}});assert.equal(f.connection.status(f.clock.now).telemetry.ch_flow_c,42);
});
const trace=(frames)=>({active:true,remaining_s:270,overwritten:0,frames});
test('bounded raw message batches validate, deduplicate across retries and decode temperature and status',t=>{
 const f=fixture(t),frames=[[1,1000,1,0,25,0],[2,500,0,4,25,0x2a80],[3,100,0,4,0,0x000a]];
 f.exchange(1,{opentherm:trace(frames)});let logs=f.connection.logs({kind:'opentherm'});assert.equal(logs.rows.length,3);assert.equal(logs.rows.find(row=>row.sequence===2).value,42.5);assert.equal(logs.rows.find(row=>row.sequence===1).value,undefined);assert.equal(logs.rows.find(row=>row.sequence===3).status.flame,true);
 assert.equal(logs.rows.find(row=>row.sequence===2).at,new Date(f.clock.now-500).toISOString());assert.equal(f.connection.status().telemetry.opentherm_capture.active,true);
 f.clock.now+=30000;f.exchange(2,{opentherm:trace(frames)});assert.equal(f.connection.logs({kind:'opentherm'}).rows.length,3);
 assert.throws(()=>f.connection.logs({kind:'opentherm',hours:25}),e=>e.status===400);assert.throws(()=>f.connection.logs({limit:5001}),e=>e.status===400);
});
test('malformed, oversized or unsorted capture batches are atomic rejects',t=>{
 const f=fixture(t);for(const frames of [[[1,0,0,4,25,65536]],[[1,90001,0,4,25,10]],[[2,0,0,4,25,1],[1,0,0,4,25,1]],Array.from({length:65},(_,i)=>[i+1,0,0,4,25,1])])assert.throws(()=>f.exchange(1,{opentherm:trace(frames)}),e=>e.status===400);
 assert.equal(f.connection.status().lastSeen,null);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM boiler_exchanges').get().n,0);
});
test('full 64-message payload fits device endpoint and legacy telemetry still works',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cold-boiler-')),app=createApplication({dataDir:dir});await new Promise(resolve=>app.deviceServer.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();remove(dir);});
 const pair=app.context.boiler.pair(),base=`http://127.0.0.1:${app.deviceServer.address().port}`;
 const data={v:1,device_id:pair.deviceId,boot_id:'a'.repeat(32),request_id:'b'.repeat(16),sequence:1,mode:'PID',telemetry:{flow_c:120,return_c:120,modulation_pct:100,pressure_bar:10,burner_starts:1e9,burner_hours:1e9,dhw_flow_l_min:100,dhw_temperature_c:120,dhw_setpoint_c:127,pid_output:1,pid_target_c:30,pid_temperature_c:60,local_temperature_c:60,requested_flow_c:80,protocol_revision:2,min_flow_c:35,max_flow_c:52,lease_remaining_s:90,free_heap_bytes:1e8,exchange_failures:1e9,opentherm_age_s:1e8,effective_mode:'x'.repeat(80),pid_source:'x'.repeat(80),network_transport:'ethernet',thermal_context:'domestic_hot_water',comfort_enabled:true,pid_available:true,heating_sample_valid:false,flame:true,ch_active:false,dhw_active:true,boiler_fault:false,frost_active:false,remote_active:false},opentherm:trace(Array.from({length:64},(_,i)=>[4294967000+i,90000-i,1,7,255,65535]))};
 assert.ok(Buffer.byteLength(JSON.stringify(signedMessage(data,pair.key)))<6144,'Full capture must fit firmware request buffer');
 let response=await fetch(base+'/v1/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(signedMessage(data,pair.key))});assert.equal(response.status,200);assert.equal(JSON.parse((await response.json()).payload).authority,'pid');
 assert.equal((await fetch(base+'/api/settings')).status,404);response=await fetch(base+'/v1/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(9000)});assert.equal(response.status,413);
});
test('status labels old readings as stale and decoders reject read placeholders as values',t=>{
 const f=fixture(t);f.exchange();assert.equal(f.connection.status(f.clock.now+90001).connected,false);
 assert.equal(decodeFrame({type:0,data_id:25,data:65535}).value,undefined);assert.equal(decodeFrame({type:7,data_id:25,data:65535}).value,undefined);assert.equal(decodeFrame({type:4,data_id:27,data:0xff00}).value,-1);
});
test('old control and direct Octopus APIs are removed; monitor screens render without secrets',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cold-boiler-')),app=createApplication({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const original=Object.getOwnPropertyDescriptor(globalThis,'location');t.after(async()=>{if(original)Object.defineProperty(globalThis,'location',original);else delete globalThis.location;await app.close();remove(dir);});
 const base=`http://127.0.0.1:${app.server.address().port}`,post=(path,body)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});
 const pair=await (await post('boiler/pair',{})).json();
 for(const path of ['boiler/test','octopus/discover'])assert.equal((await post(path,{})).status,404);
 for(const [section,values] of [['heating',{enabled:true}],['heating',{controlTarget:'thermostat'}],['homeAssistant',{climateEntity:'climate.boiler'}],['general',{demo:true}],['general',{mode:'control'}],['octopus',{apiKey:'unused'}],['energy',{source:'octopus'}]])assert.equal((await post('settings',{section,values})).status,400);
 globalThis.location={href:base+'/#boiler'};const config=await (await fetch(base+'/api/settings')).json();assert.ok(!JSON.stringify(config).includes(pair.key));
 const {connections}=await import('../public/modules/connections.js'),{heating}=await import('../public/modules/heating.js'),{boiler}=await import('../public/modules/boiler.js'),{energy}=await import('../public/modules/energy.js');
 for(const module of [connections,heating,boiler,energy]){const html=await module.render({config});assert.ok(!html.includes(pair.key));assert.ok(!html.includes('toggle-demo'));assert.ok(!html.includes('octopus-form'));assert.ok(!html.includes('Enable automatic heating'));}
 const logView=await boiler.render({config});assert.match(logView,/Recent events/);assert.match(logView,/open-boiler-diagnostics/);assert.match(logView,/view-boiler-events/);assert.doesNotMatch(logView,/id="start-capture"|Reported health|data-log-kind="readings"/);
});
test('signed telemetry, logs and replay protection survive an application restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cold-boiler-'));let store=createStore(dir);const context={store,ha:{states:[],status:{connected:false}}};let boiler=createBoilerConnection(context);const pair=boiler.pair(),message={v:1,device_id:pair.deviceId,boot_id:'c'.repeat(32),request_id:'d'.repeat(16),sequence:1,mode:'PID',telemetry:{flow_c:40}};
 try{boiler.exchange(signedMessage(message,pair.key));store.close();store=createStore(dir);boiler=createBoilerConnection({...context,store});assert.equal(boiler.history()[0].flow_c,40);assert.equal(boiler.logs().rows[0].telemetry.flow_c,40);assert.throws(()=>boiler.exchange(signedMessage(message,pair.key)),e=>e.status===409);}finally{store.close();remove(dir);}
});

test('direct capture uses bounded signed diagnostic requests while PID retains authority',async t=>{
 const f=fixture(t),opentherm={...trace([]),active:false,remaining_s:0,control_supported:true,last_control_id:''};f.exchange(1,{opentherm});
 assert.equal(f.connection.captureStatus(f.clock.now).transport,'device');await f.connection.requestCapture(true,f.clock.now);
 await assert.rejects(()=>f.connection.requestCapture(true,f.clock.now),e=>e.status===409);
 f.clock.now+=30000;let reply=f.exchange(2,{opentherm});const command=reply.diagnostic_capture;assert.equal(command.action,'start');assert.equal(command.duration_s,300);assert.equal(reply.authority,'pid');assert.equal(reply.lease_s,0);
 f.clock.now+=30000;reply=f.exchange(3,{opentherm});assert.deepEqual(reply.diagnostic_capture,command);
 f.clock.now+=30000;reply=f.exchange(4,{opentherm:{...opentherm,active:true,last_control_id:command.id}});assert.equal(reply.diagnostic_capture,undefined);assert.equal(f.connection.captureStatus(f.clock.now).request.state,'confirmed');
 await f.connection.requestCapture(false,f.clock.now);f.clock.now+=30000;reply=f.exchange(5,{opentherm});assert.equal(reply.diagnostic_capture.action,'stop');assert.equal(reply.diagnostic_capture.duration_s,0);assert.equal(reply.authority,'pid');
});
test('capture requests expire, cancel on reboot and are cleared by re-pairing',async t=>{
 const f=fixture(t),opentherm={...trace([]),active:false,remaining_s:0,control_supported:true,last_control_id:''};f.exchange(1,{opentherm});await f.connection.requestCapture(true,f.clock.now);
 f.clock.now+=121000;assert.equal(f.exchange(2,{opentherm}).diagnostic_capture,undefined);await f.connection.requestCapture(true,f.clock.now);
 f.clock.now+=30000;assert.equal(f.exchange(1,{opentherm,boot_id:'c'.repeat(32)}).diagnostic_capture,undefined);assert.equal(f.connection.captureStatus(f.clock.now).request,null);await f.connection.requestCapture(true,f.clock.now);f.connection.pair();assert.equal(f.connection.captureStatus(f.clock.now).request,null);
});
test('chart data retains every exchange and provides captured register measurements',t=>{
 const f=fixture(t);f.exchange(1,{opentherm:trace([[1,1000,0,4,25,0x2a80],[2,500,0,7,28,65535]])});f.clock.now+=30000;f.exchange(2);f.clock.now+=30000;f.exchange(3);
 const chart=f.connection.chart(15,'telemetry',f.clock.now);assert.equal(chart.points.length,3);assert.equal(f.connection.history().length,2);assert.equal(chart.resolution,'30-second device exchanges');
 const raw=f.connection.chart(15,'opentherm',f.clock.now);assert.equal(raw.points.length,1);assert.equal(raw.points[0].flow_c,42.5);assert.match(raw.resolution,/estimated/);assert.throws(()=>f.connection.chart(500),e=>e.status===400);
});

test('seven-day charts retain more than 12000 exchanges and phase/delta analysis works with either source',t=>{
 const f=fixture(t),now=f.clock.now,start=now-7*86400000,insert=f.store.db.prepare('INSERT INTO boiler_exchanges VALUES (?,?,?,?,?,?)');
 const telemetry={flow_c:48,return_c:28,ch_flow_c:48,ch_return_c:28,ch_active:true,dhw_active:false,heating_sample_valid:true,opentherm_age_s:1,thermal_context:'space_heating',pressure_bar:1};
 f.store.db.exec('BEGIN');for(let i=0;i<20160;i++)insert.run('boiler-controller','b'.repeat(32),i+1,new Date(start+i*30000).toISOString(),'PID',JSON.stringify(i===100?{...telemetry,thermal_context:'domestic_hot_water',dhw_active:true}:telemetry));f.store.db.exec('COMMIT');
 const chart=f.connection.chart(10080,'telemetry',now);assert.equal(chart.points.length,20160);assert.equal(chart.points[0].at,new Date(start).toISOString());assert.equal(chart.points[99].heating_delta_c,20);assert.equal(chart.points[100].heating_delta_c,null);assert.equal(chart.points[0].pressure_bar,undefined);assert.equal(chart.truncated,false);assert.ok(chart.phaseBands.some(b=>b.phase==='domestic_hot_water'));
 const raw=f.connection.chart(10080,'opentherm',now);assert.equal(raw.points.length,0);assert.equal(raw.heatingPoints.length,20160);assert.deepEqual(raw.phaseBands,chart.phaseBands);
});
