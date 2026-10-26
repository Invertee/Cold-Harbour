import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {defaultHeatingPlan,migrateHeatingPlan,resolveHeatingPlan,householdOccupancy} from '../server/heating-plan.js';
import {validateHeatingPlan} from '../server/validate.js';
import {evaluateHeating,heatingSummary} from '../server/modules/heating.js';
import {defaults,sampleRooms,sampleRules} from '../server/defaults.js';
import {createStore} from '../server/db.js';
import {createApplication} from '../server/app.js';
import {createHeatingHistory,warmupInsights} from '../server/modules/heating-history.js';
const now=Date.parse('2026-10-21T12:00:00Z'),plan=()=>({...structuredClone(defaultHeatingPlan),version:1});
function makeLegacyConfig(){const config=structuredClone(defaults);config.heatingPlan.version=1;return config;}
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'cold-plan-')),store=createStore(dir);t.after(()=>{store.close();const absolute=resolve(dir);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('cold-plan-'));rmSync(absolute,{recursive:true,force:true});});return store;}

test('plan validates people, activities, numeric limits and complete ordered day timelines',()=>{
 assert.equal(validateHeatingPlan(plan()).houseTarget,20);
 for(const mutate of [p=>p.houseTarget=100,p=>p.manualActivity='missing',p=>p.people=[{entityId:'switch.boiler',name:'wrong'}],p=>p.people=[{entityId:'person.sam',name:''},{entityId:'person.sam',name:''}],p=>p.activities.push(p.activities[0]),p=>p.activities[0].offset=NaN,p=>p.timeline[0][0].start=10,p=>p.timeline[0][1].start=0,p=>p.timeline[0][1].activityId='missing',p=>p.awayTimeline=[],p=>p.occupancyMode='guess',p=>p.awayDelayMinutes=-1]){const p=plan();mutate(p);assert.throws(()=>validateHeatingPlan(p),e=>e.status===400);}
});

test('occupancy uses either person, confirms everyone away, delays departure and retains home for unknown data',()=>{
 const p=plan(),memory={};p.people=[{entityId:'person.sam',name:'Sam'},{entityId:'person.partner',name:'Partner'}];
 const states=(a,b)=>[{entity_id:'person.sam',state:a,last_updated:'2020-01-01'},{entity_id:'person.partner',state:b}];
 assert.equal(householdOccupancy(p,states('not_home','home'),now,memory).effective,'home');
 let state=householdOccupancy(p,states('work','not_home'),now,memory);assert.equal(state.held,true);assert.equal(state.effective,'home');
 assert.equal(householdOccupancy(p,states('work','not_home'),now+10*60000,memory).effective,'away');
 assert.equal(householdOccupancy(p,states('not_home','unavailable'),now+11*60000,memory).effective,'home');
 assert.equal(householdOccupancy(p,[],now+12*60000,memory).observed,'unknown');
 p.occupancyMode='away';assert.equal(householdOccupancy(p,states('home','home'),now,memory).effective,'away');
});

test('home and away timelines, manual activity and local weekday/DST boundaries select the expected profile',()=>{
 const p=plan();p.people=[{entityId:'person.sam',name:'Sam'}];p.awayDelayMinutes=0;
 assert.equal(resolveHeatingPlan(p,[{entity_id:'person.sam',state:'not_home'}],now,'Europe/London',{}).profile.id,'away');
 p.manualActivity='work';assert.equal(resolveHeatingPlan(p,[],now,'Europe/London',{}).profile.id,'work');p.manualActivity='auto';
 p.timeline[0]=[{start:0,activityId:'sleep'},{start:120,activityId:'home'}];
 assert.equal(resolveHeatingPlan(p,[],Date.parse('2026-10-25T00:30:00Z'),'Europe/London',{}).profile.id,'sleep');
 assert.equal(resolveHeatingPlan(p,[],Date.parse('2026-10-25T01:30:00Z'),'Europe/London',{}).profile.id,'sleep');
 assert.equal(resolveHeatingPlan(p,[],Date.parse('2026-10-25T02:00:00Z'),'Europe/London',{}).profile.id,'home');
});

test('house target moves all room targets together while room/activity offsets and priority stay distinct',()=>{
 const config=makeLegacyConfig();config.heatingPlan.manualActivity='work';config.heatingPlan.activities.find(a=>a.id==='work').rooms={office:{offset:1,priority:5}};
 const rooms=[{id:'office',name:'Office',comfort:20,eco:16,targetOffset:0,awayOffset:0,weight:1},{id:'bedroom',name:'Bedroom',comfort:18,eco:16,targetOffset:-2,awayOffset:0,weight:1}];
 let data=evaluateHeating({rooms,rules:[],states:[],config,now});assert.deepEqual(data.rooms.map(r=>r.target),[21,18]);assert.equal(data.rooms[0].priority,5);
 config.heatingPlan.houseTarget=21.5;data=evaluateHeating({rooms,rules:[],states:[],config,now});assert.deepEqual(data.rooms.map(r=>r.target),[22.5,19.5]);assert.equal(data.mode,'listen');assert.equal(data.valveControlEnabled,false);
});

test('migration preserves seven days of room targets, priorities and overnight schedules',()=>{
 const migrated=migrateHeatingPlan(sampleRooms,sampleRules),legacyConfig=makeLegacyConfig();delete legacyConfig.heatingPlan;
 const config=makeLegacyConfig();config.heatingPlan=migrated;
 for(let day=0;day<7;day++)for(let hour=0;hour<24;hour++){
  const at=Date.parse('2026-10-19T00:00:00Z')+(day*24+hour)*3600000;
  const old=evaluateHeating({rooms:sampleRooms,rules:sampleRules,states:[],config:legacyConfig,now:at}),updated=evaluateHeating({rooms:sampleRooms,rules:sampleRules,states:[],config,now:at});
  assert.deepEqual(updated.rooms.map(r=>[r.target,r.priority]),old.rooms.map(r=>[r.target,r.priority]));
 }
});

test('migration persists the plan and old records without modifying pairing or Home Assistant credentials',t=>{
 const store=fixture(t),before=store.list('rules');store.secret('boilerKey','kept');store.secret('haToken','also-kept');assert.ok(store.config().heatingPlan.activities.length>5);assert.deepEqual(store.list('rules'),before);
 const context={store,ha:{status:{connected:false},states:[]}};store.save('heatingPlan',{...store.config().heatingPlan,people:[{entityId:'person.sam',name:'Sam'}]});const summary=heatingSummary(context,now);assert.equal(summary.plan.occupancy.observed,'unknown');assert.equal(summary.plan.occupancy.effective,'home');assert.equal(store.secret('boilerKey'),'kept');assert.equal(store.secret('haToken'),'also-kept');
});

test('migration also preserves manually selected legacy activity targets and priorities',()=>{
 for(const activity of ['home','work','evening','sleep','away']){
  const config=makeLegacyConfig(),legacy=makeLegacyConfig();delete legacy.heatingPlan;legacy.heating.activity=activity;
  config.heatingPlan=migrateHeatingPlan(sampleRooms,sampleRules,activity);
  const before=evaluateHeating({rooms:sampleRooms,rules:sampleRules,states:[],config:legacy,now}),after=evaluateHeating({rooms:sampleRooms,rules:sampleRules,states:[],config,now});
  assert.deepEqual(after.rooms.map(r=>[r.target,r.priority]),before.rooms.map(r=>[r.target,r.priority]));
 }
});

const warmSamples=(changes={})=>Array.from({length:41},(_,minute)=>({at:new Date(now+minute*60000).toISOString(),heating:true,rooms:[{id:'office',current:18+minute/40,target:21,sourceAt:new Date(now+minute*60000).toISOString(),sensorFingerprint:'["sensor.office"]',...changes}]}));
test('warm-up observations report minutes per degree from qualifying continuous heating periods',()=>{
 const result=warmupInsights(warmSamples(),[{id:'office',name:'Office'}])[0];assert.equal(result.sessions,1);assert.equal(result.minutesPerC,40);assert.equal(result.degreesPerHour,1.5);assert.equal(result.status,'early');assert.equal(result.latest[0].readings,41);
});
test('cached, cooling, short or tiny temperature changes cannot become confident warm-up estimates',()=>{
 const room=[{id:'office',name:'Office'}];
 assert.equal(warmupInsights(warmSamples({sourceAt:new Date(now).toISOString()}),room)[0].sessions,0);
 for(const rows of [warmSamples().slice(0,9),warmSamples().map(s=>({...s,heating:false})),warmSamples().map(s=>({...s,rooms:s.rooms.map(r=>({...r,current:20-(r.current-18)}))})),warmSamples().map(s=>({...s,rooms:s.rooms.map(r=>({...r,current:18+(r.current-18)*.1}))}))])assert.equal(warmupInsights(rows,room)[0].minutesPerC,null);
});
test('DHW, outages, target and sensor changes split warm-up periods instead of joining unrelated rises',()=>{
 for(const mutate of [(s,i)=>{if(i===20)s.heating=false;},(s,i)=>{if(i>=20){s.at=new Date(Date.parse(s.at)+20*60000).toISOString();s.rooms[0].sourceAt=s.at;}},(s,i)=>{if(i>=20)s.rooms[0].sensorFingerprint='different';},(s,i)=>{if(i>=20)s.rooms[0].target=23;}]){
  const rows=warmSamples();rows.forEach(mutate);const result=warmupInsights(rows,[{id:'office',name:'Office'}])[0];assert.equal(result.sessions,2);assert.ok(result.latest.every(s=>s.minutes<=20));
 }
});
test('minute history records fresh room/boiler context once and preserves missing boiler data as gaps',t=>{
 const store=fixture(t),summary=()=>({plan:{settings:{houseTarget:20},activeTarget:19,profile:{name:'Test'},occupancy:{effective:'home'}},rooms:[{id:'office',current:18,target:20,sourceAt:new Date(now).toISOString(),sensorFingerprint:'sensor.office'}]});
 let connected=true;const context={store,boiler:{status:()=>({connected,telemetry:{requested_flow_c:45,modulation_pct:30,pid_output:.6,heating_sample_valid:true,ch_active:true,dhw_active:false,flame:true,boiler_fault:false,opentherm_age_s:2,thermal_context:'space_heating'}})}};
 const history=createHeatingHistory(context,summary);history.capture(now);history.capture(now+10000);connected=false;history.capture(now+60000);
 const chart=history.chart(60,now+60000);assert.equal(chart.points.length,2);assert.equal(chart.points[0].pid_output_pct,60);assert.equal(chart.points[1].modulation_pct,null);assert.equal(chart.points[0].room_office,18);assert.equal(chart.points[0].target_office,20);assert.throws(()=>history.chart(12),e=>e.status===400);
});

test('heating plan HTTP edits persist without granting any boiler control or exposing credentials',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-plan-')),app=createApplication({dataDir:directory});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('cold-plan-'));rmSync(absolute,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`,post=values=>fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify({section:'heatingPlan',values})});
 assert.equal((await post({houseTarget:21})).status,200);assert.equal(app.context.store.config().heatingPlan.houseTarget,21);assert.equal((await post({enabled:true})).status,400);
 const data=await (await fetch(base+'/api/heating')).json();assert.equal(data.mode,'listen');assert.equal(data.valveControlEnabled,false);assert.equal((await fetch(base+'/api/heating/history?minutes=10080')).status,200);
});
