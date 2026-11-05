import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createStore} from '../server/db.js';
import {createApplication} from '../server/app.js';
import {validateBackupData} from '../server/backups.js';
import {defaults} from '../server/defaults.js';
import {validateConfig} from '../server/validate.js';
import {budgetAllowance,createGasBudget} from '../server/modules/gas-budget.js';
import {gasBudgetMarkup,gasBudgetEditor} from '../public/modules/gas-budget.js';

const now=Date.parse('2026-11-05T12:00:00Z'),zone='Europe/London';
const settings={...defaults.gasBudget,enabled:true,action:'pause',dailyLimit:50};
const periods=[{name:'Morning',start:360,end:540,share:30},{name:'Lunch',start:720,end:840,share:20},{name:'Evening',start:1020,end:1320,share:50}];
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

test('timed allowances reserve later budget, carry unused allowance, and close between windows',t=>{
 const f=fixture(t);f.store.save('gasBudget',{...settings,periods});
 const at=hour=>Date.parse(`2026-11-05T${String(hour).padStart(2,'0')}:00:00Z`);
 assert.equal(budgetAllowance({...settings,periods},at(7),zone).limit,15);
 assert.equal(budgetAllowance({...settings,periods},at(12),zone).limit,25);
 assert.equal(budgetAllowance({...settings,periods},at(18),zone).limit,50);
 f.reading(16,1,at(7));let s=f.budget.status(at(7));assert.equal(s.paused,true);assert.equal(s.dailyReached,false);
 f.reading(16,1,at(12));s=f.budget.status(at(12));assert.equal(s.paused,false);assert.equal(s.availableRemaining,9);
 f.reading(16,1,at(14));assert.equal(f.budget.status(at(14)).paused,true);
 f.store.save('gasBudget',{...settings,periods,action:'monitor'});s=f.budget.status(at(14));assert.equal(s.paused,false);assert.equal(s.wouldPause,true);
 f.store.save('gasBudget',{...settings,periods,enabled:false});assert.equal(f.budget.status(at(14)).paused,false);
});

test('caps reset by the configured local day and do not leak across meter mappings',t=>{
 const f=fixture(t);f.reading(55,4);f.budget.capture(now);
 const next=Date.parse('2026-11-06T00:01:00Z');f.reading(0,0,next);assert.equal(f.budget.status(next).paused,false);assert.equal(f.budget.status(next).used,0);
 f.reading(1,0.1);f.store.save('energy',{...f.store.config().energy,gasToday:'sensor.other_meter'});f.context.ha.states.push({...f.context.ha.states[0],entity_id:'sensor.other_meter'});assert.equal(f.budget.status(now).used,1);
 const summer=budgetAllowance({...settings,periods},Date.parse('2026-07-01T05:30:00Z'),zone);assert.equal(summer.current.name,'Morning');
 f.reading(1,0.1,Date.parse('2026-10-25T00:30:00Z'));const s=f.budget.status(Date.parse('2026-10-25T00:30:00Z'));assert.equal(s.resetsAt,'2026-10-26T00:00:00.000Z');
});

test('budget settings validate window shares, ordering, limits and explicit action',()=>{
 assert.doesNotThrow(()=>validateConfig('gasBudget',{...settings,periods},defaults.gasBudget));
 for(const input of [{dailyLimit:0},{unit:'m3'},{action:'cut-gas'},{staleMinutes:0},{enabled:'yes'},{periods:[{...periods[0],share:50}]},{periods:[{...periods[0],share:50},{...periods[0],share:50}]},{periods:[{name:'Bad',start:60,end:60,share:100}]}])assert.throws(()=>validateConfig('gasBudget',input,settings),e=>e.status===400);
});

test('budget panel and editor explain data age, delayed cutoffs and Active-only control',t=>{
 const f=fixture(t);f.reading(51,4);f.budget.capture(now);const html=gasBudgetMarkup(f.budget.chart(now),true);
 assert.match(html,/Pause requested/);assert.match(html,/Gas today & heating budget/);assert.match(html,/source|Source/);assert.match(html,/overshoot/);assert.match(html,/local fallback and frost/);assert.match(html,/gas-day-chart/);
 const editor=gasBudgetEditor({...settings,periods});assert.match(editor,/value="monitor"/);assert.match(editor,/value="pause" selected/);assert.match(editor,/Shares must total 100%/);
});

test('gas budget API saves validated settings, protects writes, and survives an application restart',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-gas-api-'));let app=createApplication({dataDir:directory});
 try{
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`,body=JSON.stringify({section:'gasBudget',values:{...settings,periods}});
  let response=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(response.status,403);
  response=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body});assert.equal(response.status,200);assert.deepEqual((await response.json()).gasBudget,{...settings,periods});
  response=await fetch(base+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify({section:'gasBudget',values:{dailyLimit:-1}})});assert.equal(response.status,400);assert.equal(app.context.store.config().gasBudget.dailyLimit,50);
  response=await fetch(base+'/api/energy/gas-budget');assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.settings.periods,periods);assert.equal(data.used,null);
  await app.close();app=createApplication({dataDir:directory});assert.deepEqual(app.context.store.config().gasBudget,{...settings,periods});
 }finally{await app.close();const p=resolve(directory);assert.ok(p.startsWith(resolve(tmpdir())+sep)&&basename(p).startsWith('cold-gas-'));rmSync(p,{recursive:true,force:true});}
});

test('older installations and backups gain disabled budget defaults without losing heating curve tuning',t=>{
 const f=fixture(t);f.store.db.prepare("DELETE FROM settings WHERE section='gasBudget'").run();const config=f.store.config();assert.deepEqual(config.gasBudget,defaults.gasBudget);
 delete config.gasBudget;for(const key of ['flowOffset','curveExponent','taperBand'])delete config.heatingPlan.weather[key];
 const backup=validateBackupData({appVersion:'0.15.0',exportedAt:new Date(now).toISOString(),config,rooms:f.store.list('rooms'),rules:f.store.list('rules'),secrets:{haToken:'',boilerKey:''}});
 assert.deepEqual(backup.config.gasBudget,defaults.gasBudget);assert.equal(backup.config.heatingPlan.weather.flowOffset,0);assert.equal(backup.config.heatingPlan.weather.curveExponent,1);assert.equal(backup.config.heatingPlan.weather.taperBand,0);
});
