import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createStore} from '../server/db.js';
import {createApplication} from '../server/app.js';
import {validateBackupData} from '../server/backups.js';
import {defaults} from '../server/defaults.js';
import {validateConfig,validateHeatingPlan} from '../server/validate.js';
import {integrateGasBudget} from '../server/heating-plan.js';
import {budgetAllowance,createGasBudget} from '../server/modules/gas-budget.js';
import {gasBudgetMarkup,gasBudgetEditor} from '../public/modules/gas-budget.js';

const now=Date.parse('2026-11-05T12:00:00Z'),zone='Europe/London';
const settings={...defaults.gasBudget,enabled:true,action:'pause',dailyLimit:50};
const periods=[{name:'Morning',start:360,end:540,share:30},{name:'Lunch',start:720,end:840,share:20},{name:'Evening',start:1020,end:1320,share:50}];
function scheduledPlan(){
 const plan=structuredClone(defaults.heatingPlan);
 for(const [id,name] of [['home','Morning'],['work','Lunch'],['evening','Evening']])plan.activities.find(p=>p.id===id).name=name;
 plan.timeline=Array.from({length:7},()=>[{start:0,activityId:'sleep',gasShare:0},{start:360,activityId:'home',gasShare:30},{start:720,activityId:'work',gasShare:20},{start:1020,activityId:'evening',gasShare:50}]);
 plan.awayTimeline=structuredClone(plan.timeline);return plan;
}
function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'cold-gas-')),store=createStore(directory);
 store.save('energy',{...store.config().energy,gasToday:'sensor.gas_today',gasTodayCost:'sensor.gas_cost'});store.save('gasBudget',settings);
 const context={store,ha:{states:[],status:{connected:true,fetchedAt:new Date(now).toISOString()}}},budget=createGasBudget(context);
 t.after(()=>{store.close();const p=resolve(directory);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('cold-gas-'));rmSync(p,{recursive:true,force:true});});
 const reading=(kwh=12,cost=1.4,at=now)=>{
  const stamp=new Date(at).toISOString();context.ha.status={connected:true,fetchedAt:stamp};context.ha.states=[{entity_id:'sensor.gas_today',state:String(kwh),last_reported:stamp,last_updated:stamp,attributes:{unit_of_measurement:'kWh'}},{entity_id:'sensor.gas_cost',state:String(cost),last_reported:stamp,last_updated:stamp,attributes:{unit_of_measurement:'GBP'}}];
 };
 return {store,context,budget,reading};
}

test('gas history records daily totals once per minute and monitors kWh and cost independently',t=>{
 const f=fixture(t);f.reading();f.budget.capture(now);f.budget.capture(now+1000);
 assert.equal(f.budget.chart(now+1000).points.length,1);let s=f.budget.status(now);assert.equal(s.used,12);assert.equal(s.remaining,38);assert.equal(s.paused,false);assert.equal(s.cost,1.4);
 f.reading(14,1.6,now+60000);f.budget.capture(now+60000);s=f.budget.chart(now+60000);assert.equal(s.points.length,2);assert.equal(s.points[1].kwh,14);assert.equal(s.points[1].cost,1.6);
 f.store.save('gasBudget',{...settings,unit:'cost',dailyLimit:1.5});s=f.budget.status(now+60000);assert.equal(s.paused,true);assert.equal(s.dailyReached,true);assert.equal(s.used,1.6);
});

test('a witnessed daily cap survives stale data, corrected totals and controller recreation',t=>{
 const f=fixture(t);f.reading(51,4);f.budget.capture(now);assert.equal(f.budget.status(now).paused,true);
 f.reading(45,3);assert.equal(createGasBudget(f.context).status(now).paused,true);
 f.context.ha.status.connected=false;f.context.ha.states.forEach(s=>s.state='unavailable');const s=f.budget.status(now+60000);
 assert.equal(s.fresh,false);assert.equal(s.paused,true);assert.equal(s.used,51);assert.equal(s.kwh,null);
});

test('missing, yesterday, future, stale, volumetric and unrelated meter data never become fresh daily usage',t=>{
 const f=fixture(t);
 for(const change of [s=>s.state='unavailable',s=>s.state='',s=>s.attributes.unit_of_measurement='m³',s=>s.last_updated='2026-11-04T12:00:00Z',s=>s.last_reported='2026-11-05T14:00:00Z',s=>s.last_reported='2026-11-05T09:00:00Z',s=>s.attributes.charges=[{start:'2026-11-04T10:00:00Z',end:'2026-11-04T10:30:00Z',consumption:12}]]){
  f.reading();change(f.context.ha.states[0]);const s=f.budget.status(now);assert.equal(s.fresh,false);assert.equal(s.paused,false);f.budget.capture(now);assert.equal(f.budget.chart(now).points[0]?.kwh ?? null,null);
 }
 f.context.ha.states=[];assert.equal(f.budget.status(now).used,null);
});

test('heating periods release reserved allowance and carry unused gas through the same schedule',t=>{
 const f=fixture(t),plan=scheduledPlan();f.store.save('heatingPlan',plan);
 const at=hour=>Date.parse(`2026-11-05T${String(hour).padStart(2,'0')}:00:00Z`);
 assert.equal(budgetAllowance(settings,at(5),zone,plan).limit,0);
 assert.equal(budgetAllowance(settings,at(7),zone,plan).limit,15);
 assert.equal(budgetAllowance(settings,at(12),zone,plan).limit,25);
 assert.equal(budgetAllowance(settings,at(18),zone,plan).limit,50);
 assert.equal(f.budget.status(at(5)).paused,true,'No allowance is released before the first allocated heating period.');
 f.reading(16,1,at(7));let s=f.budget.status(at(7));assert.equal(s.paused,true);assert.equal(s.dailyReached,false);
 f.reading(16,1,at(12));s=f.budget.status(at(12));assert.equal(s.paused,false);assert.equal(s.availableRemaining,9);
 f.reading(16,1,at(14));assert.equal(f.budget.status(at(14)).paused,false,'The heating schedule continues; there are no separate budget windows.');
 f.reading(26,1,at(14));assert.equal(f.budget.status(at(14)).paused,true);
 f.store.save('gasBudget',{...settings,action:'monitor'});s=f.budget.status(at(14));assert.equal(s.paused,false);assert.equal(s.wouldPause,true);
 f.store.save('gasBudget',{...settings,enabled:false});assert.equal(f.budget.status(at(14)).paused,false);
});

test('budget releases follow home/away selection, away delay and weekday/weekend heating groups',t=>{
 const f=fixture(t),plan=scheduledPlan();plan.people=[{entityId:'person.sam',name:'Sam'}];plan.awayDelayMinutes=10;
 for(const slots of plan.awayTimeline){slots[1].gasShare=10;slots[3].gasShare=70;}
 plan.timeline[6][1].start=480;plan.timeline[0]=structuredClone(plan.timeline[6]);
 f.store.save('heatingPlan',plan);f.reading();f.context.ha.states.push({entity_id:'person.sam',state:'not_home'});
 let s=f.budget.status(now);assert.equal(s.allowance.occupancy,'home');assert.equal(s.allowance.limit,25);
 f.reading(12,1,now+11*60000);f.context.ha.states.push({entity_id:'person.sam',state:'not_home'});s=f.budget.status(now+11*60000);assert.equal(s.allowance.occupancy,'away');assert.equal(s.allowance.limit,15);
 f.reading(12,1,now+12*60000);f.context.ha.states.push({entity_id:'person.sam',state:'unknown'});s=f.budget.status(now+12*60000);assert.equal(s.allowance.occupancy,'home');
 const saturday=Date.parse('2026-11-07T07:00:00Z');assert.equal(budgetAllowance(settings,saturday,zone,plan).limit,0);
 assert.equal(budgetAllowance(settings,Date.parse('2026-11-05T07:00:00Z'),zone,plan).limit,15);
});

test('caps reset by the configured local day and do not leak across meter mappings',t=>{
 const f=fixture(t);f.reading(55,4);f.budget.capture(now);
 const next=Date.parse('2026-11-06T00:01:00Z');f.reading(0,0,next);assert.equal(f.budget.status(next).paused,false);assert.equal(f.budget.status(next).used,0);
 f.reading(1,0.1);f.store.save('energy',{...f.store.config().energy,gasToday:'sensor.other_meter'});f.context.ha.states.push({...f.context.ha.states[0],entity_id:'sensor.other_meter'});assert.equal(f.budget.status(now).used,1);
 const summer=budgetAllowance(settings,Date.parse('2026-07-01T05:30:00Z'),zone,scheduledPlan());assert.equal(summer.current.name,'Morning');
 f.reading(1,0.1,Date.parse('2026-10-25T00:30:00Z'));const s=f.budget.status(Date.parse('2026-10-25T00:30:00Z'));assert.equal(s.resetsAt,'2026-10-26T00:00:00.000Z');
});

test('daily budget settings and per-schedule shares validate independently',()=>{
 assert.doesNotThrow(()=>validateConfig('gasBudget',settings,defaults.gasBudget));
 for(const input of [{dailyLimit:0},{unit:'m3'},{action:'cut-gas'},{staleMinutes:0},{enabled:'yes'},{periods}])assert.throws(()=>validateConfig('gasBudget',input,settings),e=>e.status===400);
 const plan=scheduledPlan();assert.deepEqual(validateHeatingPlan(plan).timeline,plan.timeline);
 for(const share of [-1,101,NaN,'30',undefined]){
  const invalid=structuredClone(plan);invalid.timeline[1][1].gasShare=share;assert.throws(()=>validateHeatingPlan(invalid),e=>e.status===400);
 }
 const allDay=structuredClone(plan);for(const slots of allDay.timeline)for(const slot of slots)slot.gasShare=0;
 assert.doesNotThrow(()=>validateHeatingPlan(allDay));assert.equal(budgetAllowance(settings,now,zone,allDay).limit,50);
});

test('budget panel and editor explain data age, delayed cutoffs and Active-only control',t=>{
 const f=fixture(t);f.reading(51,4);f.budget.capture(now);const html=gasBudgetMarkup(f.budget.chart(now),true);
 assert.match(html,/Pause requested/);assert.match(html,/Gas today & heating budget/);assert.match(html,/source|Source/);assert.match(html,/overshoot/);assert.match(html,/local fallback and frost/);assert.match(html,/gas-day-chart/);
 const editor=gasBudgetEditor({...settings,periods});assert.match(editor,/value="monitor"/);assert.match(editor,/value="pause" selected/);assert.match(editor,/Shares must total 100%/);
});

test('heating plan and budget save together, protect writes, reject partial saves and survive restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-gas-api-'));let app=createApplication({dataDir:directory});
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`,plan=scheduledPlan(),body=JSON.stringify({heatingPlan:plan,gasBudget:settings});
  let response=await fetch(base+'/api/heating/plan',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(response.status,403);
  const headers={'Content-Type':'application/json','X-MODS-Request':'1'};
  response=await fetch(base+'/api/heating/plan',{method:'POST',headers,body});assert.equal(response.status,200);assert.deepEqual((await response.json()).gasBudget,settings);
  const invalid=structuredClone(plan);invalid.timeline[1][1].gasShare=60;
  response=await fetch(base+'/api/heating/plan',{method:'POST',headers,body:JSON.stringify({heatingPlan:invalid,gasBudget:{...settings,dailyLimit:60}})});assert.equal(response.status,400);assert.equal(app.context.store.config().gasBudget.dailyLimit,50);assert.deepEqual(app.context.store.config().heatingPlan.timeline,plan.timeline);
  const renamed=structuredClone(plan);renamed.activities[0].name='Unsaved';
  response=await fetch(base+'/api/heating/plan',{method:'POST',headers,body:JSON.stringify({heatingPlan:renamed,gasBudget:{...settings,dailyLimit:-1}})});assert.equal(response.status,400);assert.notEqual(app.context.store.config().heatingPlan.activities[0].name,'Unsaved');
  response=await fetch(base+'/api/energy/gas-budget');assert.equal(response.status,200);const data=await response.json();assert.equal(data.allowance.periods.length,4);assert.equal(data.used,null);assert.equal(data.settings.periods,undefined);
  await app.close();app=createApplication({dataDir:directory});assert.deepEqual(app.context.store.config().gasBudget,settings);assert.deepEqual(app.context.store.config().heatingPlan.timeline,plan.timeline);
 }finally{await app.close();const p=resolve(directory);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('cold-gas-'));rmSync(p,{recursive:true,force:true});}
});

test('upgrade moves legacy gas shares onto unchanged heating periods and archives old settings once',t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-gas-migrate-'));let store=createStore(directory);
 t.after(()=>{store.close();const p=resolve(directory);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('cold-gas-'));rmSync(p,{recursive:true,force:true});});
 const previous=scheduledPlan();for(const key of ['timeline','awayTimeline'])for(const slots of previous[key])for(const slot of slots)delete slot.gasShare;
 store.save('heatingPlan',previous);store.save('gasBudget',{...settings,periods});store.db.prepare('DELETE FROM migrations WHERE version=13').run();store.close();store=createStore(directory);
 const saved=store.config();assert.deepEqual(saved.gasBudget,settings);assert.deepEqual(saved.heatingPlan.timeline[1].map(p=>p.gasShare || 0),[0,30,20,50]);
 assert.deepEqual(saved.heatingPlan.timeline[1].map(({gasShare,...slot})=>slot),previous.timeline[1]);assert.deepEqual(saved.heatingPlan.activities,previous.activities);
 assert.deepEqual(JSON.parse(store.db.prepare("SELECT value FROM settings WHERE section='gasBudgetBeforeHeatingSchedule'").get().value),{...settings,periods});
 const migrated=saved.heatingPlan;store.close();store=createStore(directory);assert.deepEqual(store.config().heatingPlan,migrated);
});

test('legacy backup windows migrate to heating shares while malformed allocations are rejected',t=>{
 const f=fixture(t),config=f.store.config();config.gasBudget={...settings,periods};
 const data={appVersion:'0.16.0',exportedAt:new Date(now).toISOString(),config,rooms:f.store.list('rooms'),rules:f.store.list('rules'),secrets:{haToken:'',boilerKey:''}};
 const backup=validateBackupData(data);assert.equal(backup.config.gasBudget.periods,undefined);assert.doesNotThrow(()=>validateHeatingPlan(backup.config.heatingPlan));assert.ok(backup.config.heatingPlan.timeline[1].some(slot=>slot.gasShare>0));
 const invalid=structuredClone(data);invalid.config.gasBudget.periods[0].share=-10;assert.throws(()=>validateBackupData(invalid),e=>e.status===400);
 const merged=integrateGasBudget(scheduledPlan(),{...settings,periods});assert.deepEqual(merged.plan,scheduledPlan(),'Already allocated heating periods keep their shares.');
});

test('older installations and backups gain disabled budget defaults without losing heating curve tuning',t=>{
 const f=fixture(t);f.store.db.prepare("DELETE FROM settings WHERE section='gasBudget'").run();const config=f.store.config();assert.deepEqual(config.gasBudget,defaults.gasBudget);
 delete config.gasBudget;for(const key of ['flowOffset','curveExponent','taperBand'])delete config.heatingPlan.weather[key];
 const backup=validateBackupData({appVersion:'0.15.0',exportedAt:new Date(now).toISOString(),config,rooms:f.store.list('rooms'),rules:f.store.list('rules'),secrets:{haToken:'',boilerKey:''}});
 assert.deepEqual(backup.config.gasBudget,defaults.gasBudget);assert.equal(backup.config.heatingPlan.weather.flowOffset,0);assert.equal(backup.config.heatingPlan.weather.curveExponent,1);assert.equal(backup.config.heatingPlan.weather.taperBand,0);
});
