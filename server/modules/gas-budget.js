import {resolveEnergyEntities,dailyRecord} from '../integrations/octopus-entities.js';
import {localDate,localParts,dayStart,shiftDay} from '../time.js';
import {defaults} from '../defaults.js';
import {resolveHeatingPlan} from '../heating-plan.js';
import {HttpError} from '../http.js';

function gasReading(context,now){
 const {store,ha}=context,config=store.config(),settings={...defaults.gasBudget,...config.gasBudget};
 const {gas}=resolveEnergyEntities(config,ha.states || []),day=localDate(new Date(now),config.general.timezone);
 const connectionFresh=Boolean(ha.status.connected&&now-Date.parse(ha.status.fetchedAt)<=45000&&Date.parse(ha.status.fetchedAt)<=now+60000);
 const read=(role,key)=>{
  const entity=gas.roles[role],record=dailyRecord(entity,role,config.general.timezone,now);
  const at=Date.parse(entity?.last_reported || entity?.last_updated),valid=record?.day===day&&Number.isFinite(at)&&at<=now+60000;
  return {value:valid?record[key]:null,at:valid?new Date(at).toISOString():null,fresh:Boolean(valid&&connectionFresh&&now-at<=settings.staleMinutes*60000)};
 };
 const resolved=resolveHeatingPlan(config.heatingPlan,connectionFresh?ha.states || []:[],now,config.general.timezone,ha.occupancyMemory ||= {});
 return {settings,day,source:gas.source,usage:read('today','kwh'),cost:read('todayCost','cost'),warnings:gas.warnings,timezone:config.general.timezone,plan:config.heatingPlan,resolved};
}

// The heating schedule releases each period's share of the daily budget.
// The cumulative allowance counts all household gas, including hot water, and
// carries unused allowance forward without needing an invented meter baseline.
export function budgetAllowance(settings,now,timezone,plan,resolved){
 const p=localParts(new Date(now),timezone),minute=Number(p.hour)*60+Number(p.minute),day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday);
 const occupancy=resolved?.occupancy.effective || (plan?.occupancyMode==='away'?'away':'home'),key=occupancy==='away'?'awayTimeline':'timeline',scheduleDay=plan?.version===2?(day===0||day===6?6:1):day;
 const slots=plan?.[key]?.[scheduleDay] || [],periods=slots.map((slot,i)=>({name:plan.activities.find(profile=>profile.id===slot.activityId)?.name || 'Heating period',start:slot.start,end:slots[i+1]?.start ?? 1440,share:slot.gasShare || 0}));
 const scheduled=periods.some(period=>period.share>0),current=periods.find(period=>minute>=period.start&&minute<period.end) || null;
 const share=scheduled?periods.filter(period=>minute>=period.start).reduce((sum,period)=>sum+period.share,0):100;
 return {current,share,limit:settings.dailyLimit*share/100,scheduled,periods,occupancy,next:scheduled?periods.find(period=>period.start>minute&&period.share>0) || null:null};
}

export function createGasBudget(context){
 const {store}=context;
 return {
  capture(now=Date.now()){
   const r=gasReading(context,now);if(!r.source||!r.usage.fresh&&!r.cost.fresh)return;
   const at=new Date(Math.floor(now/60000)*60000).toISOString();
   store.db.prepare(`INSERT INTO gas_samples VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,at) DO UPDATE SET
    kwh=CASE WHEN excluded.kwh IS NULL THEN gas_samples.kwh ELSE MAX(COALESCE(gas_samples.kwh,0),excluded.kwh) END,
    cost=CASE WHEN excluded.cost IS NULL THEN gas_samples.cost ELSE MAX(COALESCE(gas_samples.cost,0),excluded.cost) END,
    usage_at=COALESCE(excluded.usage_at,gas_samples.usage_at),cost_at=COALESCE(excluded.cost_at,gas_samples.cost_at)`)
    .run(r.source,r.day,at,r.usage.fresh?r.usage.value:null,r.cost.fresh?r.cost.value:null,r.usage.fresh?r.usage.at:null,r.cost.fresh?r.cost.at:null);
  },
  status(now=Date.now()){
   const r=gasReading(context,now),{settings,day,source,timezone}=r,allowance=budgetAllowance(settings,now,timezone,r.plan,r.resolved);
   const history=source?store.db.prepare('SELECT MAX(kwh) kwh,MAX(cost) cost FROM gas_samples WHERE source=? AND day=?').get(source,day):{};
   const metric=settings.unit==='cost'?r.cost:r.usage,recorded=history?.[settings.unit==='cost'?'cost':'kwh'];
   const used=metric.value===null?(recorded ?? null):Math.max(metric.value,recorded ?? metric.value);
   const dailyReached=used!==null&&used>=settings.dailyLimit,allowanceReached=allowance.limit===0||used!==null&&used>=allowance.limit;
   const unavailable=!metric.fresh;
   // A witnessed cap remains in effect through stale readings until local
   // midnight. Missing data alone never becomes zero consumption or a cap.
   const blocked=Boolean(dailyReached||allowanceReached);
   const manualPause=Boolean(source&&store.db.prepare('SELECT 1 FROM gas_budget_pauses WHERE source=? AND day=? AND timezone=?').get(source,day,timezone));
   const paused=Boolean(settings.enabled&&(manualPause||settings.action==='pause'&&blocked));
   const amount=n=>settings.unit==='cost'?`£${n.toFixed(2)}`:`${n.toFixed(1)} kWh`;
   const reason=manualPause?'Heating paused for today. Resumes after local midnight, or resume it here sooner.':dailyReached?`Daily gas budget reached (${amount(used)} / ${amount(settings.dailyLimit)}). Resumes after local midnight.`:
    allowanceReached?`Gas allowance reached (${used===null?'no reading':amount(used)} / ${amount(allowance.limit)} available so far). Waiting for the next heating schedule allocation.`:
    unavailable?'Gas reading unavailable or too old. Budget cutoff is waiting for a fresh daily reading.':`Within gas budget (${amount(used)} / ${amount(allowance.limit)} available so far).`;
   return {settings,day,source,timezone,kwh:r.usage.value,cost:r.cost.value,usageAt:r.usage.at,costAt:r.cost.at,usageFresh:r.usage.fresh,costFresh:r.cost.fresh,
    used,remaining:used===null?null:Math.max(0,settings.dailyLimit-used),availableRemaining:used===null?null:Math.max(0,allowance.limit-used),
    fraction:used===null?null:Math.min(1,used/settings.dailyLimit),fresh:metric.fresh,paused,manualPause,wouldPause:blocked,dailyReached,
    state:!settings.enabled?'disabled':paused?'paused':blocked?'limit':unavailable?'waiting':'within',reason,allowance,
    resetsAt:new Date(dayStart(shiftDay(day,1),timezone)).toISOString(),warnings:r.warnings};
  },
  pause(now=Date.now()){
   const s=this.status(now);
   if(!s.settings.enabled||!s.source)throw new HttpError(409,'Enable a gas budget and choose a gas meter before pausing heating.');
   store.db.prepare('INSERT OR IGNORE INTO gas_budget_pauses VALUES (?,?,?)').run(s.source,s.day,s.timezone);
   context.thermostat?.reset();
   store.log('heating','Heating paused for today from the gas budget. Frost protection remains available.');
   return this.status(now);
  },
  resume(now=Date.now()){
   const s=this.status(now);
   store.db.exec('BEGIN');
   try{
    store.db.prepare('DELETE FROM gas_budget_pauses WHERE source=? AND day=? AND timezone=?').run(s.source,s.day,s.timezone);
    // An old notification must not undo a later explicit resume.
    store.db.prepare('UPDATE gas_budget_notifications SET consumed=1 WHERE day=?').run(s.day);
    store.db.exec('COMMIT');
   }catch(error){store.db.exec('ROLLBACK');throw error;}
   context.thermostat?.reset();
   store.log('heating','Today’s manual gas budget pause cleared. Automatic budget limits still apply.');
   return this.status(now);
  },
  chart(now=Date.now()){
   const status=this.status(now),points=status.source?store.db.prepare('SELECT at,kwh,cost,usage_at,cost_at FROM gas_samples WHERE source=? AND day=? ORDER BY at').all(status.source,status.day):[];
   return {...status,start:new Date(dayStart(status.day,status.timezone)).toISOString(),end:new Date(now).toISOString(),points};
  },
 };
}
