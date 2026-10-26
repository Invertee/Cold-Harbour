import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,basename,sep } from 'node:path';
import { createStore } from '../server/db.js';
import { createApplication } from '../server/app.js';
import { captureHomeAssistantEnergy,discoverOctopusEntities,resolveEnergyEntities,pounds } from '../server/integrations/octopus-entities.js';
import { energySummary } from '../server/modules/energy.js';
import { dayStart } from '../server/time.js';

const now=Date.parse('2026-10-21T12:00:00Z');
function clean(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&/^mods-entities-/.test(basename(target)));rmSync(target,{recursive:true,force:true});}
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'mods-entities-'));const store=createStore(directory);store.save('general',{mode:'listen',timezone:'Europe/London'});const context={store,ha:{states:[],status:{connected:true,fetchedAt:new Date(now).toISOString()}},octopus:{status:{}}};t.after(()=>{store.close();clean(directory);});return context;}
function rows(day,values,costs){const start=dayStart(day,'Europe/London');return values.map((value,i)=>({start:new Date(start+i*1800000).toISOString(),end:new Date(start+(i+1)*1800000).toISOString(),consumption:value,...(costs?{cost:costs[i],cost_raw:costs[i]}:{})}));}
function sensor(fuel,suffix,value,units,attrs={},serial=fuel==='gas'?'GAS123':'ELEC123'){
  const point=fuel==='gas'?'1234567890':'1234567890123';
  return {entity_id:`sensor.octopus_energy_${fuel}_${serial.toLowerCase()}_${point}_${suffix}`,state:String(value),last_updated:new Date(now).toISOString(),last_reported:new Date(now).toISOString(),attributes:{unit_of_measurement:units,serial_number:serial,[fuel==='gas'?'mprn':'mpan']:point,is_export:false,...attrs}};
}
function sampleStates(){return [
  sensor('electricity','current_demand',768,'W'),
  sensor('electricity','current_accumulative_consumption',3,'kWh',{charges:rows('2026-10-21',[1,2])}),
  sensor('electricity','current_accumulative_cost',1.1,'GBP',{charges:rows('2026-10-21',[1,2],[.1,.4]),standing_charge:.6,tariff_code:'E-1R-AGILE'}),
  sensor('electricity','current_rate',.08,'GBP/kWh',{start:'2026-10-21T11:30:00Z',end:'2026-10-21T12:30:00Z',tariff:'E-1R-AGILE'}),
  sensor('gas','current_accumulative_consumption_kwh',15,'kWh',{charges:rows('2026-10-21',[5,10])}),
  sensor('gas','current_accumulative_cost',1.2,'GBP',{charges:rows('2026-10-21',[5,10],[.3,.6]),standing_charge:.3,tariff_code:'G-1R-FIXED'}),
  sensor('gas','current_rate',.06,'GBP/kWh'),
];}

test('discovers electricity and gas while excluding export, lifetime and off-peak variants',()=>{
  const states=sampleStates();states.push(sensor('electricity','export_current_accumulative_consumption',200,'kWh',{is_export:true}),sensor('electricity','current_total_consumption',50000,'kWh'),sensor('electricity','current_accumulative_cost_off_peak',.3,'GBP'));
  const meters=discoverOctopusEntities(states);assert.equal(meters.length,2);const electricity=meters.find(m=>m.fuel==='electricity');assert.match(electricity.roles.today,/_current_accumulative_consumption$/);assert.match(electricity.roles.todayCost,/_current_accumulative_cost$/);assert.equal(Object.keys(electricity.roles).length,4);
});
test('uses reported costs, variable-rate charges and standing charges without estimating or double counting',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates();captureHomeAssistantEnergy(ctx,now);const data=energySummary(ctx,'today',now);
  assert.equal(data.electricity.kwh,3);assert.equal(data.electricity.cost,1.1);assert.equal(data.electricity.unitRate,8);assert.equal(data.electricity.standingCharge,60);assert.equal(data.electricity.estimated,false);
  assert.equal(data.gas.kwh,15);assert.equal(data.gas.cost,1.2);assert.equal(data.gas.unitRate,6);assert.equal(data.live.watts,768);assert.equal(data.live.fresh,true);assert.deepEqual(data.electricity.rows.map(r=>r.cost),[.1,.4]);
});
test('repeated polling does not double-count daily consumption or interval charges',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates();captureHomeAssistantEnergy(ctx,now);captureHomeAssistantEnergy(ctx,now+15000);const data=energySummary(ctx,'today',now+15000);assert.equal(data.electricity.kwh,3);assert.equal(data.electricity.cost,1.1);assert.equal(data.electricity.rows.length,2);assert.equal(ctx.store.db.prepare('SELECT COUNT(*) count FROM energy_days').get().count,2);
});
test('gas cubic metres and lifetime readings are never presented as daily kWh',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates().filter(s=>!s.entity_id.endsWith('consumption_kwh'));
  ctx.ha.states.push(sensor('gas','current_accumulative_consumption_m3',1.4,'m³',{charges:rows('2026-10-21',[.5,.9])}),sensor('gas','current_total_consumption_kwh',20000,'kWh'));
  captureHomeAssistantEnergy(ctx,now);const data=energySummary(ctx,'today',now);assert.equal(data.gas.kwh,null);assert.equal(data.gas.cost,1.2);assert.equal(data.gas.rows.length,0);
});
test('delayed previous-day data retains the actual day from its interval timestamps',t=>{
  const ctx=fixture(t);ctx.ha.states=[sensor('electricity','previous_accumulative_consumption',4,'kWh',{charges:rows('2026-10-19',[2,2])}),sensor('electricity','previous_accumulative_cost',1.6,'GBP',{charges:rows('2026-10-19',[2,2],[.4,.6]),standing_charge:.6})];
  captureHomeAssistantEnergy(ctx,now);assert.equal(energySummary(ctx,'yesterday',now).kwh,null);const week=energySummary(ctx,'week',now);assert.equal(week.kwh,4);assert.equal(week.cost,1.6);assert.equal(week.electricity.coverage.usageDays,1);assert.equal(ctx.store.db.prepare('SELECT day FROM energy_days').get().day,'2026-10-19');
});
test('a daily sensor still reporting yesterday after midnight is not imported as today',t=>{
  const ctx=fixture(t);ctx.ha.states=[sensor('electricity','current_accumulative_consumption',6,'kWh',{charges:rows('2026-10-20',[3,3])})];captureHomeAssistantEnergy(ctx,now);assert.equal(energySummary(ctx,'today',now).kwh,null);assert.equal(energySummary(ctx,'yesterday',now).kwh,6);
});
test('multiple import meters require a selection and cannot be combined accidentally',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates();ctx.ha.states.push(sensor('electricity','current_accumulative_consumption',30,'kWh',{charges:rows('2026-10-21',[10,20])},'SECOND'));
  captureHomeAssistantEnergy(ctx,now);assert.equal(energySummary(ctx,'today',now).kwh,null);
  const selected=discoverOctopusEntities(ctx.ha.states).find(m=>m.serial==='ELEC123');ctx.store.save('energy',{...ctx.store.config().energy,electricityMeter:selected.id});captureHomeAssistantEnergy(ctx,now);assert.equal(energySummary(ctx,'today',now).kwh,3);
  ctx.store.save('energy',{...ctx.store.config().energy,electricityToday:ctx.ha.states.at(-1).entity_id});const mapping=resolveEnergyEntities(ctx.store.config(),ctx.ha.states);assert.equal(mapping.electricity.roles.today,undefined);assert.match(mapping.electricity.warnings.join(' '),/different meter/);
});
test('renamed entity IDs work through meter attributes, friendly names and explicit mappings',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates();const reading=ctx.ha.states[0];reading.entity_id='sensor.house_power';reading.attributes.friendly_name='House Current Demand';assert.ok(discoverOctopusEntities(ctx.ha.states).some(m=>m.roles.demand==='sensor.house_power'));
  ctx.store.save('energy',{...ctx.store.config().energy,electricityDemand:'sensor.house_power'});captureHomeAssistantEnergy(ctx,now);assert.equal(energySummary(ctx,'today',now).live.watts,768);
});
test('unavailable entities retain cached readings with an explicit status and never turn into zero',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates();captureHomeAssistantEnergy(ctx,now);ctx.ha.states[2].state='unavailable';captureHomeAssistantEnergy(ctx,now+15000);let data=energySummary(ctx,'today',now+15000);assert.equal(data.electricity.cost,1.1);assert.equal(data.electricity.cached,true);ctx.ha.status.connected=false;data=energySummary(ctx,'today',now+30000);assert.equal(data.live.fresh,false);assert.equal(data.gas.cached,true);
});
test('expired tariff rates are not used for current cost-per-hour estimates',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates();ctx.ha.states[3].attributes.end='2026-10-21T11:00:00Z';captureHomeAssistantEnergy(ctx,now);const data=energySummary(ctx,'today',now);assert.equal(data.electricity.unitRate,null);assert.equal(data.electricity.cost,1.1);assert.equal(pounds(25,{attributes:{unit_of_measurement:'p/kWh'}},true),.25);
});
test('the spring clock change imports 46 half-hour intervals as the correct local day',t=>{
  const ctx=fixture(t),dstNow=Date.parse('2026-03-30T12:00:00Z');ctx.ha.states=[sensor('electricity','previous_accumulative_consumption',46,'kWh',{charges:rows('2026-03-29',Array(46).fill(1))})];captureHomeAssistantEnergy(ctx,dstNow);const data=energySummary(ctx,'yesterday',dstNow);assert.equal(data.electricity.rows.length,46);assert.equal(data.kwh,46);
});
test('daily costs and consumption retain independent completeness when official data arrives separately',t=>{
  const ctx=fixture(t);ctx.ha.states=[sensor('electricity','current_accumulative_consumption',3,'kWh',{charges:rows('2026-10-20',[1,2])}),sensor('electricity','previous_accumulative_cost',2,'GBP',{charges:rows('2026-10-20',[2,3],[.4,1]),standing_charge:.6})];
  captureHomeAssistantEnergy(ctx,now);let data=energySummary(ctx,'yesterday',now);assert.equal(data.kwh,3);assert.equal(data.cost,2);assert.equal(data.electricity.coverage.partialUsageDays,1);assert.equal(data.electricity.coverage.partialCostDays,0);
  ctx.ha.states.push(sensor('electricity','previous_accumulative_consumption',5,'kWh',{charges:rows('2026-10-20',[2,3])}));captureHomeAssistantEnergy(ctx,now+15000);data=energySummary(ctx,'yesterday',now+15000);assert.equal(data.kwh,5);assert.equal(data.cost,2);assert.equal(data.electricity.coverage.partialUsageDays,0);
});
test('rates event entities supply current and next prices when rate sensors are disabled',t=>{
  const ctx=fixture(t);ctx.ha.states=sampleStates().filter(s=>!s.entity_id.endsWith('current_rate'));const event=sensor('electricity','current_day_rates','2026-10-21T11:00:00Z','',{rates:[{start:'2026-10-21T11:30:00Z',end:'2026-10-21T12:30:00Z',value_inc_vat:.08},{start:'2026-10-21T12:30:00Z',end:'2026-10-21T13:00:00Z',value_inc_vat:.12}]});event.entity_id=event.entity_id.replace(/^sensor\./,'event.');ctx.ha.states.push(event);captureHomeAssistantEnergy(ctx,now);const data=energySummary(ctx,'today',now);assert.equal(data.unitRate,8);assert.equal(data.electricity.nextRate.value,12);
});
test('all application network reads go through Home Assistant',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mods-entities-')),requests=[];const app=createApplication({dataDir:directory,haRegistryRequest:async()=>[],haRequest:async(url,options)=>{requests.push({url,options});return sampleStates();}});t.after(async()=>{await app.close();clean(directory);});
  const {store}=app.context;store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test-token');await app.tick();assert.equal(requests.length,1);assert.equal(requests[0].url,'http://ha.test/api/states');assert.equal(app.context.ha.status.connected,true);assert.equal(app.context.octopus,undefined);
});
