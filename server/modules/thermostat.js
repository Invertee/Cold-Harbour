import {HttpError} from '../http.js';

const clamp=(n,low,high)=>Math.max(low,Math.min(high,n));
// Initial proportional allocation. This is requested travel, not measured flow or kW.
export function valvePlan(room){
 const opening=room.fresh&&room.callingForHeat?clamp(Math.ceil(Math.max(0,room.deficit)/2*20)*5,10,100):0;
 return {roomId:room.id,entityId:room.radiatorEntity,opening,closing:100,
  roomTarget:room.target,deviceTarget:opening?Math.min(room.target+5,Math.max(room.target+3,(room.radiator?.currentTemperature ?? room.current)+1)):room.target,
  reason:!room.fresh?'Room reading unavailable':opening?`${room.priority==='high'?'Comfort':'Setback'} demand`:'Room target satisfied'};
}

export function createThermostat(context,summary){
 const {store,ha}=context,attempts=new Map();let busy=false,epoch=0;
 const mode=()=>store.config().thermostat?.mode || 'planning';
 const fingerprint=()=>JSON.stringify([ha.generation,store.config().heatingPlan,store.config().boiler.deviceId,store.list('rooms')]);
 function inspect(now=Date.now(),data=summary(now),boiler=context.boiler?.status(now)){
  const active=mode()==='active',t=boiler?.telemetry || {},checks=[];
  const check=(id,label,ok,detail)=>checks.push({id,label,ok:Boolean(ok),detail});
  check('ha','Home Assistant connected',ha.status.connected&&now-Date.parse(ha.status.fetchedAt)<=45000,'Fresh Home Assistant readings are required.');
  check('esp','ESP Smart Thermostat mode',boiler?.connected&&boiler.selectedMode==='Cold Harbour','Select Cold Harbour on the ESP; Local PID stays a local override.');
  check('feedback','Boiler feedback available',t.opentherm_age_s<90&&t.boiler_fault===false,'Wait for fresh OpenTherm feedback without a reported fault.');
  check('comfort','Central Heating Enabled',t.comfort_enabled===true,'Turn on Central Heating Enabled on the ESP. Local frost protection retains priority.');
  check('rooms','Room temperatures available',data.smartPlan&&data.rooms.some(r=>r.fresh),'At least one fresh room temperature is required.');
  const lower=Math.max(30,t.min_flow_c ?? 80),upper=Math.min(65,t.max_flow_c ?? 0);
  check('limits','ESP flow limits reported',t.protocol_revision>=2&&Number.isFinite(lower)&&Number.isFinite(upper)&&lower<=upper,'Wait for the ESP to report compatible flow limits.');
  const valves=data.rooms.filter(r=>r.radiatorEntity).map(room=>{
   const plan=valvePlan(room),device=ha.valveContext?.(room.radiatorEntity,now),prepared=ha.prepareValve?.(room,plan,now);
   const last=attempts.get(room.id),same=last?.fingerprint===fingerprint()&&last?.signature===JSON.stringify(plan);
   const observed=Boolean(prepared?.confirmed&&(!same||Date.parse(ha.status.fetchedAt)>=last.at));
   return {...plan,ready:Boolean(room.fresh&&prepared?.ready),confirmed:observed,deviceTarget:prepared?.deviceTarget ?? plan.deviceTarget,
    openingEntity:device?.opening?.entityId || null,closingEntity:device?.closing?.entityId || null,
    reportedOpening:device?.opening?.value ?? null,reportedClosing:device?.closing?.value ?? null,
    adaptive:device?.adaptive?.state ?? null,error:same?last.error || null:null,
    detail:!room.fresh?'Fresh room temperature required':prepared?.reason || 'Waiting for verified ZHA valve controls'};
  });
  check('valves','TRVZB controls available',valves.every(v=>v.ready),'Each mapped TRV needs enabled opening/closing entities and its Adaptive mode switch.');
  const ready=checks.every(c=>c.ok),confirmed=valves.every(v=>v.confirmed),errors=valves.some(v=>v.error);
  return {mode:mode(),active,ready,checks,valves,canGrant:active&&ready&&confirmed&&!errors,
   state:!active?'planning':!ready?'waiting':errors?'valve-error':!confirmed?'preparing':'active',
   reason:!active?'Planning only · no heating or radiator commands':!ready?checks.find(c=>!c.ok).detail:errors?'Radiator command failed; heat is held while the settings are retried.':!confirmed?'Preparing radiator settings; boiler heat is held until Home Assistant reports them.':'Coordinated boiler and radiator control',
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
   store.log('heating',`Smart Thermostat: ${next}. ${next==='planning'?'TRV writes stopped; the next signed exchange releases the boiler to Local PID.':'Waiting for ESP mode, fresh readings and verified TRV controls.'}`);
   // Selection is immediate. Actuation happens on the host poll, never from a browser timer.
   return inspect();
  },
  async sync(now=Date.now()){
   if(busy||mode()!=='active')return;busy=true;
   try{
    const data=summary(now),status=inspect(now,data);if(!status.ready)return;
    const version=epoch,snapshot=fingerprint();
    for(const plan of status.valves){
     if(mode()!=='active'||epoch!==version||fingerprint()!==snapshot)break;
     const room=data.rooms.find(r=>r.id===plan.roomId),raw=valvePlan(room),signature=JSON.stringify(raw),last=attempts.get(room.id);
     if(plan.confirmed&&!plan.error)continue;
     if(last&&last.entityId===raw.entityId&&now-last.at<(last.signature===signature&&last.fingerprint===snapshot?300000:60000))continue;
     attempts.set(room.id,{at:now,signature,entityId:raw.entityId,fingerprint:snapshot,error:null});
     const isCurrent=()=>mode()==='active'&&epoch===version&&fingerprint()===snapshot&&inspect(Date.now()).ready;
     try{await ha.applyValvePlan(room,raw,isCurrent);store.log('radiator',`${room.name}: ${raw.opening}% opening requested, room target ${room.target.toFixed(1)}°C.`);}
     catch{attempts.set(room.id,{at:now,signature,entityId:raw.entityId,fingerprint:snapshot,error:'Check the ZHA device controls and Home Assistant connection.'});}
    }
   }finally{busy=false;}
  },
  response(data,boiler,now){
   const status=inspect(now,data,boiler);
   if(!status.active||!status.ready)return {authority:'pid',enabled:false,flow_c:0,lease_s:0,reason:status.reason};
   const enabled=Boolean(status.canGrant&&data.smartPlan.heat);
   return {authority:'remote',enabled,flow_c:enabled?status.flowC:0,lease_s:90,reason:enabled?data.smartPlan.reason:status.canGrant?'Room targets satisfied':status.reason};
  },
 };
}
