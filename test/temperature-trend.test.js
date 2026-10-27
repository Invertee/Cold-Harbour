import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {roomTemperatureTrends} from '../server/temperature-trend.js';
import {temperatureTrend,roomCard} from '../public/room-card.js';
import {createApplication} from '../server/app.js';
import metadata from '../package.json' with {type:'json'};

const now=Date.parse('2026-10-27T17:00:00Z'),stamp=at=>new Date(at).toISOString(),fingerprint='["sensor.office"]';
const room=(current=20,at=now)=>({id:'office',name:'Office',fresh:true,current,sourceAt:stamp(at),sensorFingerprint:fingerprint});
const samples=(rate=0.02,count=21)=>Array.from({length:count},(_,i)=>{const at=now-(20-i)*60000;return {at:stamp(at),heating:false,rooms:[room(20+i*rate,at)]};});
const trend=(rows,current=room(rows.at(-1)?.rooms[0].current ?? 20))=>roomTemperatureTrends(rows,[current],now).office;

test('twenty-minute trends show warming, cooling or stable regardless of heating state',()=>{
 for(const [rate,direction] of [[0.02,'rising'],[-0.02,'falling'],[0,'stable'],[0.003,'stable']]){
  const result=trend(samples(rate));assert.equal(result.direction,direction);assert.equal(result.windowMinutes,20);assert.equal(result.minutes,20);assert.equal(result.readings,21);assert.equal(result.changeC,Math.round(rate*20*1000)/1000);
 }
 // A single brief excursion must not turn an otherwise flat room into a trend.
 const noise=samples(0);noise[10].rooms[0].current+=0.5;assert.equal(trend(noise).direction,'stable');
 const boundary=samples(0.005);assert.equal(trend(boundary).direction,'rising');assert.equal(trend(samples(-0.005)).direction,'falling');
});

test('older temperatures do not dominate the recent window and actual source reports are deduplicated',()=>{
 const old=Array.from({length:20},(_,i)=>{const at=now-(40-i)*60000;return {at:stamp(at),rooms:[room(30-i,at)]};});
 assert.equal(trend([...old,...samples()]).direction,'rising');
 const held=samples().map((s,i)=>{const sourceMinute=Math.floor(i/5)*5;return {...s,rooms:[room(20+sourceMinute*.02,now-(20-sourceMinute)*60000)]};});
 assert.equal(trend(held).direction,'rising');assert.equal(trend(held).readings,5);
 const cached=samples().map(s=>({...s,rooms:[room(20,now-19*60000)]}));assert.equal(trend(cached,room(20,now-19*60000)).direction,'unavailable');
});

test('short history, sparse reports, stale sources and missing live temperatures cannot look stable',()=>{
 assert.equal(trend(samples().slice(-10)).direction,'unavailable');
 assert.equal(trend(samples().slice(-11)).direction,'rising');
 for(const current of [room(null),{...room(),fresh:false},{...room(),sensorFingerprint:''},room(20,now-6*60000)])assert.equal(trend(samples(),current).direction,'unavailable');
 const sparse=samples().map((s,i)=>({...s,rooms:[room(i<20?20:21,i<20?now-20*60000:now)]}));assert.equal(trend(sparse,room(21)).direction,'unavailable');
 const future=samples().map(s=>({...s,rooms:[room(20,now+60000)]}));assert.equal(trend(future,room(20,now+60000)).direction,'unavailable');
});

test('sensor changes, unavailable periods and collection gaps reset trend evidence',()=>{
 for(const modify of [
  rows=>{rows[14].rooms[0].sensorFingerprint='["sensor.other"]';},
  rows=>{rows[14].rooms[0].current=null;},
  rows=>{rows[14].rooms=[];},
  rows=>rows.splice(11,4),
 ]){
  const rows=samples();modify(rows);assert.equal(trend(rows).direction,'unavailable');
 }
 // Targets can change without changing the direction of the measured temperature.
 const rows=samples();rows.forEach((s,i)=>{s.rooms[0].target=i<10?18:22;});assert.equal(trend(rows).direction,'rising');
});

test('room cards place accessible arrows after the temperature and distinguish unavailable data',()=>{
 for(const direction of ['rising','falling','stable']){
  const current={...room(),target:20,trend:{...trend(samples()),direction}};
  const html=roomCard(current,{leadRoomId:null});assert.match(html,new RegExp(`°C</span><span class="room-trend trend-${direction}"`));assert.match(html,new RegExp(`aria-label="Temperature ${direction} over the last 20 minutes`));assert.match(html,/title="Temperature/);
 }
 assert.match(temperatureTrend({...room(),fresh:false,trend:trend(samples())}),/trend-unavailable/);
 assert.match(temperatureTrend(room()),/needs at least 10 minutes of recent readings/);
});

test('heating API derives each room trend from saved history, survives restart and reports the app version',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-trend-')),options={dataDir:directory,haRequest:async()=>[{entity_id:'sensor.office',state:'20.4',attributes:{unit_of_measurement:'°C'},last_reported:stamp(Date.now())}],haRegistryRequest:async()=>[]};let app=createApplication(options);
 t.after(async()=>{await app.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('cold-trend-'));rmSync(absolute,{recursive:true,force:true});});
 const at=Date.now(),office={...app.context.store.list('rooms')[0],sensorEntity:'sensor.office',sensorEntities:['sensor.office']};app.context.store.put('rooms',office);
 const rows=samples().map((s,i)=>({at:stamp(at-(20-i)*60000),snapshot:JSON.stringify({rooms:[{...s.rooms[0],id:office.id,sourceAt:stamp(at-(20-i)*60000)}]})}));
 const insert=app.context.store.db.prepare('INSERT INTO heating_samples VALUES (?,?)');for(const row of rows)insert.run(row.at,row.snapshot);
 app.context.store.save('homeAssistant',{...app.context.store.config().homeAssistant,url:'http://fixture.invalid'});app.context.store.secret('haToken','isolated-trend-fixture');
 const start=async()=>{await app.context.ha.poll();await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+app.server.address().port;};
 let base=await start();let response=await fetch(base+'/api/heating'),data=await response.json();assert.equal(response.status,200);assert.equal(data.rooms.find(r=>r.id===office.id).trend.direction,'rising');
 const health=await (await fetch(base+'/health')).json();assert.equal(health.version,metadata.version);
 await app.close();app=createApplication(options);base=await start();data=await (await fetch(base+'/api/heating')).json();assert.equal(data.rooms.find(r=>r.id===office.id).trend.direction,'rising');
 app.context.ha.invalidate();data=await (await fetch(base+'/api/heating')).json();assert.ok(data.rooms.every(r=>r.trend.direction==='unavailable'));
});
