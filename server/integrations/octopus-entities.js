import { localDate,shiftDay } from '../time.js';
import { powerReading } from './home-assistant.js';

export const energyRoles = ['demand','today','todayCost','previous','previousCost','rate'];
const normalize = value=>String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const number = value=>value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
const available = entity=>entity && !['unknown','unavailable','none',''].includes(entity.state);
const unit = entity=>String(entity?.attributes?.unit_of_measurement || '').toLowerCase().replace(/\s/g,'');
export const kwhValue = (value,entity)=>{const n=number(value);return n === null?null:unit(entity)==='kwh'?n:unit(entity)==='wh'?n/1000:null;};
export function pounds(value,entity,rate=false) {
  const n=number(value);if(n===null)return null;
  const u=unit(entity).replace(rate?'/kwh':'/day','');
  return ['gbp','£'].includes(u)?n:['p','pence','gbpence','gbx'].includes(u)?n/100:null;
}
function meterInfo(entity) {
  const a=entity.attributes || {};
  if(a.is_export === true || a.is_export === 'true' || /_export_/.test(entity.entity_id))return null;
  const match=entity.entity_id.match(/^(?:sensor|event)\.octopus_energy_(electricity|gas)_(.+)_(\d+)_(?:current|previous|next)_/);
  const fuel=a.mprn?'gas':a.mpan?'electricity':match?.[1];
  const serial=String(a.serial_number || match?.[2] || '');
  const meter=String((fuel==='gas'?a.mprn:a.mpan) || match?.[3] || '');
  if(!fuel || !serial || !meter)return null;
  return {id:`${fuel}:${serial.toLowerCase()}:${meter}`,fuel,serial,meter};
}
function roleFor(entity,fuel) {
  const names=[normalize(entity.entity_id),normalize(entity.attributes?.friendly_name)];
  const ends=suffix=>names.some(name=>name.endsWith(suffix));
  if(ends('current_demand') && ['w','kw'].includes(unit(entity)))return 'demand';
  if(ends('current_accumulative_cost'))return 'todayCost';
  if(ends('previous_accumulative_cost'))return 'previousCost';
  if(ends('current_accumulative_consumption') || ends('current_accumulative_consumption_kwh'))return ['kwh','wh'].includes(unit(entity))?'today':null;
  if(ends('previous_accumulative_consumption') || ends('previous_accumulative_consumption_kwh'))return ['kwh','wh'].includes(unit(entity))?'previous':null;
  if(ends('current_rate'))return 'rate';
  if(ends('next_rate'))return 'nextRate';
  if(ends('current_day_rates'))return 'ratesToday';
  if(ends('next_day_rates'))return 'ratesNext';
  return null;
}
export function discoverOctopusEntities(states=[]) {
  const meters=new Map();
  for(const entity of states) {
    const info=meterInfo(entity);if(!info)continue;
    if(!meters.has(info.id))meters.set(info.id,{...info,entities:[],candidates:{},roles:{},warnings:[]});
    const meter=meters.get(info.id),role=roleFor(entity,info.fuel);
    meter.entities.push(entity.entity_id);
    if(role)(meter.candidates[role] ||= []).push(entity);
  }
  return [...meters.values()].filter(meter=>Object.keys(meter.candidates).length).map(meter=>{
    for(const [role,candidates] of Object.entries(meter.candidates)) {
      const active=candidates.filter(available),choices=active.length?active:candidates;
      if(choices.length===1)meter.roles[role]=choices[0].entity_id;
      else meter.warnings.push(`Choose the ${role} entity explicitly; multiple candidates were found.`);
    }
    delete meter.candidates;return meter;
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
export function resolveEnergyEntities(config,states=[]) {
  const discovered=discoverOctopusEntities(states),byId=new Map(states.map(s=>[s.entity_id,s]));
  const resolved={};
  for(const fuel of ['electricity','gas']) {
    const candidates=discovered.filter(m=>m.fuel===fuel),selected=config.energy?.[`${fuel}Meter`];
    const meter=selected?candidates.find(m=>m.id===selected):candidates.length===1?candidates[0]:null;
    const roles={},warnings=[...(meter?.warnings || [])];
    if(!meter)warnings.push(selected?'The selected meter is unavailable.':candidates.length>1?`Select which ${fuel} meter belongs to this home.`:`No ${fuel} meter entities found.`);
    for(const role of energyRoles) {
      const key=`${fuel}${role[0].toUpperCase()+role.slice(1)}`;
      let id=config.energy?.[key] || meter?.roles[role] || '';
      if(fuel==='electricity' && role==='demand' && !config.energy?.[key] && config.homeAssistant?.powerEntity)id=config.homeAssistant.powerEntity;
      const value=byId.get(id);
      const info=value&&meterInfo(value);
      if(value && ((info && info.fuel!==fuel) || (meter && info && info.id!==meter.id) || value.attributes?.is_export === true || value.attributes?.is_export === 'true' || /_export_/.test(id)))warnings.push(`The mapped ${role} entity belongs to a different meter or export supply.`);
      else if(value)roles[role]=value;
      else if(id)warnings.push(`Entity unavailable: ${id}`);
    }
    for(const role of ['nextRate','ratesToday','ratesNext'])if(meter?.roles[role])roles[role]=byId.get(meter.roles[role]);
    // Explicit mappings also support renamed/non-standard daily sensors without meter metadata.
    const explicit=energyRoles.map(role=>config.energy?.[`${fuel}${role[0].toUpperCase()+role.slice(1)}`]).filter(Boolean);
    const source=meter?.id || (explicit.length?`manual:${fuel}:${explicit.join('|')}`:null);
    resolved[fuel]={meter,roles,source,warnings};
  }
  return {meters:discovered,...resolved};
}
function chargeRows(entity,kind,now) {
  if(!available(entity) || !Array.isArray(entity.attributes?.charges))return [];
  const rows=new Map();
  for(const charge of entity.attributes.charges) {
    const start=Date.parse(charge.start),end=Date.parse(charge.end);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end<=start || start>now+60000)continue;
    const kwh=kind==='usage'?kwhValue(charge.consumption,entity):null;
    const cost=kind==='cost'?number(charge.cost_raw ?? charge.cost):null;
    if(kwh===null && cost===null)continue;
    if(kwh!==null && kwh<0)continue;
    rows.set(start,{start:new Date(start).toISOString(),end:new Date(end).toISOString(),kwh,cost});
  }
  return [...rows.values()].sort((a,b)=>a.start.localeCompare(b.start));
}
function dailyRecord(entity,role,timezone,now) {
  if(!available(entity))return null;
  const cost=role.endsWith('Cost'),rows=chargeRows(entity,cost?'cost':'usage',now);
  const days=[...new Set(rows.map(row=>localDate(new Date(row.start),timezone)))];
  let day=days.length===1?days[0]:null;
  // A "previous" entity can contain data from several days ago. Never call it yesterday without timestamps.
  if(!day && !rows.length && !role.startsWith('previous')) {
    const at=Date.parse(entity.attributes?.last_reset || entity.last_updated);
    if(Number.isFinite(at) && at<=now+60000)day=localDate(new Date(at),timezone);
  }
  if(!day)return null;
  const total=cost?pounds(entity.state,entity):kwhValue(entity.state,entity);
  if(total===null || (!cost && total<0))return null;
  return {day,kwh:cost?null:total,cost:cost?total:null,standingCharge:cost?number(entity.attributes?.standing_charge):null,rows,quality:role.startsWith('previous')?2:1};
}
export function captureHomeAssistantEnergy({store,ha},now=Date.now()) {
  const config=store.config(),mapping=resolveEnergyEntities(config,ha.states || []);
  if(!ha.status.connected)return mapping;
  const at=new Date(now).toISOString();
  const interval=store.db.prepare(`INSERT INTO energy_intervals VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,fuel,start) DO UPDATE SET
    end=excluded.end, kwh=COALESCE(excluded.kwh,energy_intervals.kwh),
    cost=CASE WHEN excluded.quality>energy_intervals.quality OR (excluded.kwh IS NOT NULL AND energy_intervals.kwh IS NOT NULL AND ABS(excluded.kwh-energy_intervals.kwh)>0.00000001) THEN excluded.cost ELSE COALESCE(excluded.cost,energy_intervals.cost) END,
    quality=excluded.quality, updated_at=excluded.updated_at WHERE excluded.quality>=energy_intervals.quality`);
  const daily=store.db.prepare(`INSERT INTO energy_days (source,fuel,day,kwh,cost,standing_charge,quality,updated_at,usage_quality,cost_quality) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,fuel,day) DO UPDATE SET
    kwh=CASE WHEN excluded.kwh IS NOT NULL AND excluded.usage_quality>=energy_days.usage_quality THEN excluded.kwh ELSE energy_days.kwh END,
    cost=CASE WHEN excluded.cost IS NOT NULL AND excluded.cost_quality>=energy_days.cost_quality THEN excluded.cost ELSE energy_days.cost END,
    standing_charge=CASE WHEN excluded.cost_quality>=energy_days.cost_quality THEN COALESCE(excluded.standing_charge,energy_days.standing_charge) ELSE energy_days.standing_charge END,
    quality=MAX(excluded.quality,energy_days.quality),usage_quality=MAX(excluded.usage_quality,energy_days.usage_quality),
    cost_quality=MAX(excluded.cost_quality,energy_days.cost_quality),updated_at=excluded.updated_at`);
  store.db.exec('BEGIN');
  try {
    for(const fuel of ['electricity','gas']) {
      const {source,roles}=mapping[fuel];if(!source)continue;
      for(const role of ['today','todayCost','previous','previousCost']) {
        const record=dailyRecord(roles[role],role,config.general.timezone,now);if(!record)continue;
        daily.run(source,fuel,record.day,record.kwh,record.cost,record.standingCharge,record.quality,at,record.kwh===null?0:record.quality,record.cost===null?0:record.quality);
        for(const row of record.rows)interval.run(source,fuel,row.start,row.end,row.kwh,row.cost,record.quality,at);
      }
    }
    const demand=mapping.electricity.roles.demand,reading=powerReading(demand,now);
    if(reading)store.db.prepare('INSERT OR REPLACE INTO readings VALUES (?,?,?)').run(`ha:${demand.entity_id}`,reading.at,reading.watts);
    store.db.exec('COMMIT');
  } catch(error){store.db.exec('ROLLBACK');throw error;}
  return mapping;
}
export function integrationFuelSummary({store,ha},mapping,fuel,range,period,now=Date.now()) {
  const {source,roles,meter,warnings}=mapping[fuel];
  const today=range.today,endDay=period==='yesterday'?shiftDay(today,-1):today;
  const days=source?store.db.prepare('SELECT * FROM energy_days WHERE source=? AND fuel=? AND day>=? AND day<=? ORDER BY day').all(source,fuel,range.day,endDay):[];
  const energyDays=days.filter(day=>day.kwh!==null),costDays=days.filter(day=>day.cost!==null);
  const rows=source?store.db.prepare('SELECT start,end,kwh,cost FROM energy_intervals WHERE source=? AND fuel=? AND start>=? AND start<? AND kwh IS NOT NULL ORDER BY start').all(source,fuel,new Date(range.start).toISOString(),new Date(range.end).toISOString()):[];
  const rate=roles.rate,rateStart=Date.parse(rate?.attributes?.start),rateEnd=Date.parse(rate?.attributes?.end);
  const rateValid=available(rate) && (!Number.isFinite(rateStart)||rateStart<=now) && (!Number.isFinite(rateEnd)||rateEnd>now);
  const eventRates=[roles.ratesToday,roles.ratesNext].filter(available).flatMap(entity=>Array.isArray(entity.attributes?.rates)?entity.attributes.rates:[]).map(item=>({...item,value:number(item.value_inc_vat),from:Date.parse(item.start),to:Date.parse(item.end)})).filter(item=>item.value!==null&&Number.isFinite(item.from)&&Number.isFinite(item.to)&&item.to>item.from).sort((a,b)=>a.from-b.from);
  const currentEvent=eventRates.find(item=>item.from<=now&&item.to>now);
  const unitRate=(rateValid?pounds(rate.state,rate,true):null) ?? currentEvent?.value ?? null;
  const next=roles.nextRate,nextStart=Date.parse(next?.attributes?.start);
  const nextRate=available(next) && Number.isFinite(nextStart) && nextStart>now?pounds(next.state,next,true):null;
  const nextEvent=eventRates.find(item=>item.from>now&&item.value!==unitRate);
  const dayCost=roles.todayCost;
  const standingCharge=available(dayCost)?number(dayCost.attributes?.standing_charge):null;
  const latest=rows.at(-1)?.end || null;
  return {
    fuel,source:source?'BottlecapDave / Home Assistant':null,meter:meter?{id:meter.id,serial:meter.serial,meter:meter.meter}:null,
    kwh:energyDays.length?energyDays.reduce((sum,day)=>sum+day.kwh,0):null,
    cost:costDays.length?costDays.reduce((sum,day)=>sum+day.cost,0):null,estimated:false,
    unitRate:unitRate===null?null:unitRate*100,standingCharge:standingCharge===null?null:standingCharge*100,
    tariff:rate?.attributes?.tariff || dayCost?.attributes?.tariff_code || roles.ratesToday?.attributes?.tariff_code || null,
    nextRate:nextRate!==null?{value:nextRate*100,start:next.attributes.start,end:next.attributes.end}:nextEvent?{value:nextEvent.value*100,start:nextEvent.start,end:nextEvent.end}:null,
    rateAdjusted:Boolean(rateValid?rate?.attributes?.is_intelligent_adjusted:currentEvent?.is_intelligent_adjusted),
    rows,latestInterval:latest,coverage:{usageDays:energyDays.length,costDays:costDays.length,expectedDays:period==='week'?7:1,partialUsageDays:energyDays.filter(day=>day.day<today&&day.usage_quality<2).length,partialCostDays:costDays.filter(day=>day.day<today&&day.cost_quality<2).length},
    cached:!ha.status.connected || (period==='today' && ((energyDays.length>0&&!available(roles.today)) || (costDays.length>0&&!available(roles.todayCost)))),warnings,
    entities:Object.fromEntries(energyRoles.map(role=>[role,roles[role]?.entity_id || null])),
  };
}
