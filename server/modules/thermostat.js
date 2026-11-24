import {HttpError} from '../http.js';
import {requestedOpening,roomThresholds,roomControl,heatingTarget} from '../../public/heating-model.js';

const clamp=(n,low,high)=>Math.max(low,Math.min(high,n));
// Requested travel from the room response, not measured water flow or kW.
export function valvePlan(room){
 const override=room.radiatorOverride,manual=override&&!override.paused;
 const opening=manual?override.opening:requestedOpening(room);
 const target=manual&&opening>0?Math.max(room.target,room.current):heatingTarget(room);
 return {roomId:room.id,entityId:room.radiatorEntity,opening,closing:100,...roomThresholds(room),response:roomControl(room),
  scheduledOpening:room.scheduledOpening ?? opening,
  roomTarget:room.target,deviceTarget:opening?Math.min(target+5,Math.max(target+3,(room.radiator?.currentTemperature ?? room.current)+1.5)):target,
  reason:manual?'Temporary valve override':!room.fresh?'Room reading unavailable':room.budgetPaused?'Paused by gas budget':room.emergencyHeating?'Emergency room heating':opening?`${room.priority==='high'?'Comfort':'Setback'} demand`:room.coasting?room.sunCompensation?.reductionC>0?'Allowing for sunshine':'Coasting to target':'Room target satisfied'};
}

export function createThermostat(context,summary){
 const {store,ha}=context,attempts=new Map();let busy=false,epoch=0;
 const mode=()=>store.config().thermostat?.mode || 'planning';
 const fingerprint=()=>JSON.stringify([ha.generation,store.config().heatingPlan,store.config().gasBudget,store.config().boiler.deviceId,store.list('rooms')]);
 const signature=valve=>JSON.stringify([valve.opening,valve.deviceTarget]);
 function inspect(now=Date.now(),data=summary(now),boiler=context.boiler?.status(now)){
  const active=mode()==='active',t=boiler?.telemetry || {},checks=[];
  const check=(id,label,ok,detail)=>checks.push({id,label,ok:Boolean(ok),detail});
  check('ha','Home Assistant',ha.status.connected&&now-Date.parse(ha.status.fetchedAt)<=45000,'Connect Home Assistant');
  check('esp','ESP mode',boiler?.connected&&boiler.selectedMode==='Cold Harbour',boiler?.connected?'Select Cold Harbour on the ESP':'Waiting for the ESP');
  check('feedback','Boiler feedback',t.opentherm_age_s<90&&t.boiler_fault===false,t.boiler_fault?'Check the boiler fault':'Waiting for OpenTherm feedback');
  check('comfort','Central heating',t.comfort_enabled===true,'Turn on Central Heating Enabled on the ESP');
  check('rooms','Room temperatures',data.smartPlan&&data.rooms.some(r=>r.fresh),'Waiting for room temperatures');
  const lower=Math.max(30,t.min_flow_c ?? 80),upper=Math.min(65,t.max_flow_c ?? 0);
  check('limits','ESP flow limits',t.protocol_revision>=2&&Number.isFinite(lower)&&Number.isFinite(upper)&&lower<=upper,'Waiting for compatible ESP flow limits');
  const blocker=checks.find(c=>!c.ok)?.detail,snapshot=fingerprint();
  const valves=data.rooms.filter(r=>r.radiatorEntity).map(room=>{
   const plan=valvePlan(room),device=ha.valveContext?.(room.radiatorEntity,now),prepared=ha.prepareValve?.(room,plan,now);
   const deviceTarget=prepared?.deviceTarget ?? plan.deviceTarget;
   const last=attempts.get(room.id),sameDevice=last?.entityId===plan.entityId&&last.generation===ha.generation;
   const same=sameDevice&&last.fingerprint===snapshot&&last.signature===signature({...plan,deviceTarget});
   const confirmed=Boolean(prepared?.confirmed&&(!sameDevice||!last.pending&&ha.stateRevision>last.revision));
   const ready=Boolean(room.fresh&&prepared?.ready);
   const blockedBy=!room.fresh?'Waiting for room temperature':!prepared?.ready?prepared?.reason || 'Waiting for verified ZHA controls':null;
   const blocked=blockedBy || (!active?'Select Active to control the valve':blocker) || null;
   const tooWarm=confirmed&&plan.opening>0&&room.radiator?.currentTemperature>=deviceTarget;
   return {...plan,ready,confirmed,deviceTarget,canOverride:!blocked,blocked,
    openingEntity:device?.opening?.entityId || null,closingEntity:device?.closing?.entityId || null,
    reportedOpening:device?.opening?.enabled?device.opening.value:null,reportedClosing:device?.closing?.value ?? null,
    adaptive:device?.adaptive?.state ?? null,error:same&&!confirmed?last.error:null,
    detail:blockedBy || (tooWarm?'TRV reads at or above its device target':confirmed?'Settings confirmed':'Waiting for Home Assistant to report settings')};
  });
  check('valves','Radiator controls',valves.every(v=>v.ready),valves.find(v=>!v.ready)?.detail || '');
  const ready=checks.every(c=>c.ok),confirmed=valves.every(v=>v.confirmed),errors=valves.some(v=>v.error);
  return {mode:mode(),active,ready,checks,valves,canGrant:active&&ready&&confirmed&&!errors,
   state:!active?'planning':!ready?'waiting':errors?'valve-error':!confirmed?'preparing':data.budget?.paused&&!data.budget.frostOverride?'budget-paused':'active',
   reason:!active?'Planning only':!ready?checks.find(c=>!c.ok).detail:errors?'Check the radiator connection':!confirmed?'Waiting for radiator settings':data.budget?.frostOverride?data.smartPlan.reason:data.budget?.paused?data.budget.reason:'Boiler and radiators ready',
   flowC:ready&&data.smartPlan?.heat?Number(clamp(data.smartPlan.flowC,lower,upper).toFixed(1)):0,
   selectedEspMode:boiler?.selectedMode || null,reportedRemote:Boolean(boiler?.connected&&t.remote_active),leaseSeconds:90};
 }
 return {
  reset(){epoch++;attempts.clear();},
  status:inspect,
  async setMode(next){
   if(!['planning','active'].includes(next))throw new HttpError(400,'Choose Planning or Active.');
   if(store.config().heatingPlan.version!==2)throw new HttpError(409,'Upgrade to the current heating schedule first.');
   if(next===mode())return inspect();
   epoch++;attempts.clear();store.save('thermostat',{mode:next});
   if(next==='planning')for(const {radiatorOverride,...room} of store.list('rooms'))if(radiatorOverride)store.put('rooms',room);
   store.log('heating',`Smart Thermostat: ${next}. ${next==='planning'?'TRV writes stopped; the next signed exchange releases the boiler to Local PID.':'Waiting for ESP mode, fresh readings and verified TRV controls.'}`);
   // Selection is immediate. Actuation happens on the host poll, never from a browser timer.
   return inspect();
  },
  setValveOverride({roomId,opening,minutes,...extra}){
   const cancel=opening===null;
   if(typeof roomId!=='string'||Object.keys(extra).length||(cancel?minutes!==undefined:!Number.isInteger(opening)||opening<0||opening>100||![15,30,60,120].includes(minutes)))throw new HttpError(400,'Choose an opening from 0–100% and a duration.');
   const room=store.list('rooms').find(r=>r.id===roomId&&r.radiatorEntity);
   if(!room)throw new HttpError(404,'Map a radiator to this room first.');
   const now=Date.now();
   if(!cancel){
    const valve=inspect(now).valves.find(v=>v.roomId===roomId);
    if(!valve?.canOverride)throw new HttpError(409,valve?.blocked || 'Radiator control unavailable');
    room.radiatorOverride={opening,until:now+minutes*60000};
   }else{
    delete room.radiatorOverride;
   }
   store.put('rooms',room);
   store.log('radiator',cancel?`${room.name}: resumed automatic valve control`:`${room.name}: ${opening}% opening for ${minutes} minutes`);
   return {override:room.radiatorOverride || null};
  },
  async sync(now=Date.now()){
   if(busy||mode()!=='active')return;busy=true;
   try{
    const data=summary(now),status=inspect(now,data);
    const version=epoch,snapshot=fingerprint();
    for(const plan of status.valves){
     if(mode()!=='active'||epoch!==version||fingerprint()!==snapshot)break;
     if(!plan.canOverride)continue;
     const room=data.rooms.find(r=>r.id===plan.roomId),raw=valvePlan(room),command=signature(plan),last=attempts.get(room.id);
     if(plan.confirmed){attempts.delete(room.id);continue;}
     if(last?.entityId===raw.entityId&&last.generation===ha.generation&&last.opening===raw.opening&&now-last.at<(last.fingerprint===snapshot&&last.signature===command?300000:60000))continue;
     const attempt={at:now,opening:raw.opening,signature:command,entityId:raw.entityId,fingerprint:snapshot,generation:ha.generation,pending:true,error:null};
     attempts.set(room.id,attempt);
     const isCurrent=()=>{
      if(mode()!=='active'||epoch!==version||fingerprint()!==snapshot)return false;
      const current=inspect().valves.find(v=>v.roomId===room.id);
      return current?.canOverride&&signature(current)===command;
     };
     try{await ha.applyValvePlan(room,raw,isCurrent);store.log('radiator',`${room.name}: ${raw.opening}% opening requested, room target ${room.target.toFixed(1)}°C.`);}
     catch{if(isCurrent())attempt.error='Check the radiator in Home Assistant';}
     finally{attempt.pending=false;attempt.revision=ha.stateRevision;}
    }
   }finally{busy=false;}
  },
  response(data,boiler,now){
   const status=inspect(now,data,boiler);
   if(!status.active||!status.ready)return {authority:'pid',enabled:false,flow_c:0,lease_s:0,reason:status.reason};
   const enabled=Boolean(status.canGrant&&data.smartPlan.heat);
   return {authority:'remote',enabled,flow_c:enabled?status.flowC:0,lease_s:90,reason:status.canGrant?data.smartPlan.reason:status.reason};
  },
 };
}
