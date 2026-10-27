import { temperature,temperatureReport } from '../integrations/home-assistant.js';
import { localParts } from '../time.js';
import {resolveHeatingPlan,scheduledRoomTarget,temporaryHouseSetpoint} from '../heating-plan.js';
import {createHeatingHistory} from './heating-history.js';
import {createRadiatorControl} from './radiators.js';
import {HttpError} from '../http.js';
import {smartThermostatPlan} from '../smart-thermostat.js';
import {createHeatingOutlook} from './heating-outlook.js';
import {createThermostat,valvePlan} from './thermostat.js';

const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function roomPresence(room,byId,now,maxAge,memory) {
  const clues = [...(room.presenceRules || [])];
  if (room.occupancyEntity) clues.unshift({entityId:room.occupancyEntity,condition:'is',value:'on'});
  const fingerprint = JSON.stringify([clues,room.presenceMode,room.presenceHoldMinutes]);
  let previous = memory.get(room.id);
  if (previous?.fingerprint !== fingerprint) { memory.delete(room.id); previous = null; }
  const active = [], unknown = [];
  for (const clue of clues) {
    const state = byId.get(clue.entityId);
    if (!state || state.state === '' || state.state == null || ['unknown','unavailable'].includes(state.state)) { unknown.push(clue.entityId); continue; }
    // A switch may stay on for days. Its state is read from HA's fresh snapshot;
    // numeric measurements additionally require a recent source report.
    if (clue.condition === 'above' || clue.entityId.startsWith('sensor.')) {
      const at = Date.parse(state.last_reported || state.last_updated);
      if (!Number.isFinite(Number(state.state)) || !Number.isFinite(at) || now-at>maxAge || at-now>60000) { unknown.push(clue.entityId); continue; }
    }
    if (clue.condition === 'above' ? Number(state.state)>clue.value : state.state===clue.value) active.push(state.attributes?.friendly_name || clue.entityId);
  }
  if (active.length) memory.set(room.id,{fingerprint,lastSeen:now});
  const lastSeen = active.length ? now : previous?.lastSeen;
  const held = !active.length && Number.isFinite(lastSeen) && now>=lastSeen && now-lastSeen<(room.presenceHoldMinutes ?? 20)*60000;
  return {configured:clues.length>0,occupied:active.length>0 || held,held,active,unknown:unknown.length>0};
}
export function ruleActive(rule,now,timezone) {
  if (!rule.enabled) return false;
  const p = localParts(new Date(now),timezone), day = weekdays.indexOf(p.weekday), time = `${p.hour}:${p.minute}`;
  if (rule.start<rule.end) return rule.days.includes(day) && time>=rule.start && time<rule.end;
  return (rule.days.includes(day) && time>=rule.start) || (rule.days.includes((day+6)%7) && time<rule.end);
}
export function evaluateHeating({rooms,rules,states,config,now=Date.now(),presenceMemory=new Map(),occupancyMemory={},temperatureUnit=null,demandMemory=new Map()}) {
  const {heating,general} = config;
  const byId = new Map(states.map(s=>[s.entity_id,s]));
  const plan=config.heatingPlan?resolveHeatingPlan(config.heatingPlan,states,now,general.timezone,occupancyMemory):null;
  const scheduled=config.heatingPlan?.version===2;
  const matches = plan?[]:rules.filter(rule=>ruleActive(rule,now,general.timezone));
  const activity = plan?plan.profile.id:heating.activity === 'auto' ? [...matches].sort((a,b)=>b.priority-a.priority)[0]?.activity || 'home' : heating.activity;
  const maxAge = heating.staleMinutes*60000;
  const evaluated = rooms.map(room=>{
    const sensorEntities=Array.isArray(room.sensorEntities)?room.sensorEntities:room.sensorEntity?[room.sensorEntity]:[];
    const selectedEntities=sensorEntities;
    const sensorFreshnessMinutes=room.sensorFreshnessMinutes ?? heating.staleMinutes,roomMaxAge=sensorFreshnessMinutes*60000;
    const measurements=selectedEntities.map(entityId=>({entityId,name:byId.get(entityId)?.attributes?.friendly_name || entityId,kind:entityId.startsWith('climate.')?'thermostat':'sensor',freshnessMinutes:sensorFreshnessMinutes,...temperatureReport(byId.get(entityId),now,roomMaxAge,entityId.startsWith('climate.'),temperatureUnit)}));
    const readings=measurements.filter(sensor=>sensor.value!==null);
    const current=readings.length?readings.reduce((sum,sensor)=>sum+sensor.value,0)/readings.length:null;
    const matching = plan?plan.profile.rooms[room.id]:(heating.activity === 'auto' ? matches : rules.filter(r=>r.enabled && r.activity === activity)).filter(r=>r.roomId === room.id).sort((a,b)=>b.priority-a.priority)[0];
    const presence = roomPresence(room,byId,now,maxAge,presenceMemory);
    const occupied = presence.occupied;
    const away = plan?plan.profile.targetMode==='setback':activity === 'away';
    const presenceControlsTarget = room.presenceMode === 'comfort' && presence.configured;
    const baseTarget = activity==='sleep' ? room.eco : presenceControlsTarget && !occupied && !presence.unknown ? room.eco : room.comfort;
    const offset=away?(room.awayOffset ?? room.eco-16):(room.targetOffset ?? room.comfort-20);
    const planned=plan?Math.max(5,Math.min(28,plan.baseTarget+offset+plan.profile.offset+(matching?.offset || 0))):null;
    const presenceSetback=presenceControlsTarget&&!away&&!occupied&&!presence.unknown&&matching?.presenceSetback!==false;
    const priority = scheduled?(matching?.priority==='high'?'high':'low'):plan?Math.max(matching?.priority || 1,occupied&&!away?3:1):away ? 1 : Math.max(matching?.priority || 1,occupied?3:1);
    const target = scheduled?scheduledRoomTarget(room,priority,config.heatingPlan,{...plan.profile,houseTarget:plan.activeTarget}):plan?presenceSetback?Math.min(planned,room.eco):planned:away ? room.eco : matching?.target ?? baseTarget;
    const reason = scheduled?`${plan.override?`${plan.profile.name} · sensor override`:`${plan.occupancy.effective==='away'?'Away':'Home'} schedule`} · ${priority==='high'?'comfort':'low temperature'}${priority==='high'?' target':''}`:plan?`${plan.profile.name}${presenceSetback?' · room Eco setback':occupied?' · room in use':''}`:away ? 'Away setback' : matching?.name || (occupied ? presence.held ? 'Recent presence' : 'Room in use' : presenceControlsTarget && presence.unknown && activity!=='sleep' ? 'Presence unavailable · comfort retained' : presenceControlsTarget ? 'No presence · Eco target' : activity==='sleep' ? 'Sleep setback' : 'Base comfort');
    const deficit = current === null ? null : target-current;
    const demandKey=JSON.stringify([target,selectedEntities,priority]),previousDemand=demandMemory.get(room.id);
    const callingForHeat=current!==null&&(deficit>0.2||scheduled&&current<7||previousDemand?.key===demandKey&&previousDemand.calling&&deficit>0);
    demandMemory.set(room.id,{key:demandKey,calling:callingForHeat});
    const radiator = byId.get(room.radiatorEntity);
    const radiatorAvailable = Boolean(radiator && !['unknown','unavailable'].includes(radiator.state));
    const sourceAt=readings.length?new Date(Math.max(...readings.map(r=>Date.parse(r.reportedAt)))).toISOString():null;
    const unit=radiator?.attributes?.temperature_unit || radiator?.attributes?.unit_of_measurement || temperatureUnit;
    const reportedTarget=radiator?.attributes?.temperature;
    const currentTarget=radiatorAvailable&&typeof reportedTarget==='number'&&Number.isFinite(reportedTarget)&&['°C','°F'].includes(unit)?unit==='°F'?(reportedTarget-32)*5/9:reportedTarget:null;
    return {...room,measurements,sourceAt,sensorFingerprint:JSON.stringify(readings.map(r=>r.entityId).sort()),sensorEntities:selectedEntities,sensorCount:selectedEntities.length,sensorCountUsed:readings.length,current,target,priority,effectiveWeight:scheduled?1:room.weight*priority,occupied,presence,reason,fresh:current !== null,deficit,callingForHeat,radiator:room.radiatorEntity?{entityId:room.radiatorEntity,name:radiator?.attributes?.friendly_name || room.radiatorEntity,available:radiatorAvailable,currentTarget,currentTemperature:temperature(radiator,now,maxAge,true,temperatureUnit),mode:radiatorAvailable?radiator.state:null,action:radiatorAvailable?radiator.attributes?.hvac_action || null:null,usedInAverage:selectedEntities.includes(room.radiatorEntity),target,preview:config.thermostat?.mode!=='active'}:null};
  });
  const usable = evaluated.filter(room=>room.fresh);
  const totalWeight = usable.reduce((sum,r)=>sum+r.effectiveWeight,0);
  const average = totalWeight ? usable.reduce((sum,r)=>sum+r.current*r.effectiveWeight,0)/totalWeight : null;
  const desired = totalWeight ? usable.reduce((sum,r)=>sum+r.target*r.effectiveWeight,0)/totalWeight : null;
  const demanding = usable.filter(room=>room.callingForHeat);
  const controlRoom = demanding.length ? [...demanding].sort((a,b)=>b.deficit*b.effectiveWeight-a.deficit*a.effectiveWeight)[0] : [...usable].sort((a,b)=>b.deficit-a.deficit)[0];
  const blocked = !usable.length ? 'Map fresh room temperatures to explore comfort and schedules.' : evaluated.some(room=>!room.fresh) ? 'Some rooms have no fresh readings.' : null;
  const smartPlan=scheduled?smartThermostatPlan(evaluated,config.heatingPlan,states,now):null;
  if(smartPlan)smartPlan.planningOnly=config.thermostat?.mode!=='active';
  return {mode:config.thermostat?.mode==='active'?'active':'listen',smartPlan,activity,configuredActivity:plan?config.heatingPlan.manualActivity:heating.activity,plan:plan?{...plan,settings:config.heatingPlan}:null,rooms:evaluated,rules,average,desired,blocked,controlRoomId:smartPlan?smartPlan.leadRoomId:controlRoom?.id || null,demandingRoomCount:demanding.length,controlStrategy:scheduled?'scheduled-priority':'room-demand',valveControlEnabled:false};
}

export function heatingSummary({store,ha},now=Date.now(),config=store.config()) {
  const rooms = store.list('rooms');
  const live = ha.status.connected && now-Date.parse(ha.status.fetchedAt)<=45000;
  return evaluateHeating({rooms,rules:store.list('rules'),states:live?ha.states:[],config,now,presenceMemory:ha.presenceMemory ||= new Map(),occupancyMemory:ha.occupancyMemory ||= {},temperatureUnit:ha.temperatureUnit,demandMemory:ha.demandMemory ||= new Map()});
}
export const heatingModule = {
  id:'heating',name:'Heating',description:'Scheduled room priorities and coordinated boiler/radiator control with Planning and Active modes.',
  register({route,context}) {
    context.heatingHistory=createHeatingHistory(context,now=>heatingSummary(context,now));
    context.heatingOutlook=createHeatingOutlook(context,now=>heatingSummary(context,now));
    context.radiators=createRadiatorControl(context,now=>heatingSummary(context,now));
    context.thermostat=createThermostat(context,now=>heatingSummary(context,now));
    route('POST','/api/heating/setpoint',({body})=>{
      if(!body||Object.keys(body).some(k=>k!=='target')||typeof body.target!=='number'||!Number.isFinite(body.target)||body.target<7||body.target>28)throw new HttpError(400,'Choose a house setpoint between 7 and 28°C.');
      const now=Date.now(),config=context.store.config(),data=heatingSummary(context,now,config);
      if(config.heatingPlan.version!==2)throw new HttpError(400,'Temporary setpoints need a scheduled heating plan.');
      const setpointOverride=temporaryHouseSetpoint(config.heatingPlan,data.plan,body.target,now,config.general.timezone);
      context.store.save('heatingPlan',{...config.heatingPlan,setpointOverride});
      return heatingSummary(context,now);
    });
    route('GET','/api/heating/control',()=>context.thermostat.status());
    route('POST','/api/heating/control',({body})=>{if(!body||Object.keys(body).some(k=>k!=='mode'))throw new HttpError(400,'Choose only the thermostat mode.');return context.thermostat.setMode(body.mode);});
    route('GET','/api/heating',()=>{
      const data=heatingSummary(context),control=context.thermostat.status();
      const trends=context.heatingHistory.trends(data.rooms);
      return {...data,outlook:context.heatingOutlook.read().summary,control,
       valveControlEnabled:control.active?control.ready:data.plan?.settings.version!==2&&data.rooms.some(room=>room.radiatorEntity&&room.radiatorMode&&room.radiatorMode!=='monitor'),
       rooms:data.rooms.map(room=>({...room,trend:trends[room.id],radiatorControl:room.radiator?context.radiators.status(room.id):null,valvePlan:room.radiator?valvePlan(room):null})),
       controller:{message:control.active?control.reason:'Planning only; Local PID controls the boiler and radiator settings stay unchanged.'}};
    });
    route('POST','/api/heating/radiator',({body})=>{if(Object.keys(body).some(k=>!['roomId','mode'].includes(k)))throw new HttpError(400,'Only a room and radiator mode are supported.');return context.radiators.setMode(body.roomId,body.mode);});
    route('GET','/api/heating/history',({url})=>context.heatingHistory.chart(Number(url.searchParams.get('minutes') || 1440)));
    route('GET','/api/heating/insights',()=>context.heatingHistory.insights());
    route('GET','/api/heating/analysis',()=>({...context.heatingHistory.analysis(),outlook:context.heatingOutlook.read()}));
  },
};
