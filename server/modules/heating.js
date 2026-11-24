import { temperature,temperatureReport } from '../integrations/home-assistant.js';
import { localParts } from '../time.js';
import {resolveHeatingPlan,scheduledRoomTarget,temporaryHouseSetpoint} from '../heating-plan.js';
import {createHeatingHistory} from './heating-history.js';
import {createRadiatorControl} from './radiators.js';
import {HttpError} from '../http.js';
import {smartThermostatPlan} from '../smart-thermostat.js';
import {createHeatingOutlook} from './heating-outlook.js';
import {createThermostat} from './thermostat.js';
import {roomControl,requestedOpening} from '../../public/heating-model.js';
import {sunlightReading,roomSunCompensation} from '../sun-compensation.js';

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
  const sunlight=sunlightReading(config.heatingPlan?.weather,states,now);
  const matches = plan?[]:rules.filter(rule=>ruleActive(rule,now,general.timezone));
  const activity = plan?plan.profile.id:heating.activity === 'auto' ? [...matches].sort((a,b)=>b.priority-a.priority)[0]?.activity || 'home' : heating.activity;
  const maxAge = heating.staleMinutes*60000;
  const evaluated = rooms.map(({radiatorOverride,...room})=>{
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
    const sunCompensation=roomSunCompensation(room,target,current,sunlight),heatingTarget=sunCompensation.heatingTargetC,controlDeficit=current===null?null:heatingTarget-current;
    const heatControl=roomControl(room),demandKey=JSON.stringify([target,selectedEntities,priority,heatControl,room.sunExposure ?? 0]),previousDemand=demandMemory.get(room.id);
    const callingForHeat=current!==null&&(controlDeficit>heatControl.startBelow||scheduled&&current<7||previousDemand?.key===demandKey&&previousDemand.calling&&controlDeficit>heatControl.stopBelow);
    const coasting=current!==null&&deficit>0&&controlDeficit<=heatControl.stopBelow;
    demandMemory.set(room.id,{key:demandKey,calling:callingForHeat});
    const radiator = byId.get(room.radiatorEntity);
    const radiatorAvailable = Boolean(radiator && !['unknown','unavailable'].includes(radiator.state));
    const sourceAt=readings.length?new Date(Math.max(...readings.map(r=>Date.parse(r.reportedAt)))).toISOString():null;
    const unit=radiator?.attributes?.temperature_unit || radiator?.attributes?.unit_of_measurement || temperatureUnit;
    const reportedTarget=radiator?.attributes?.temperature;
    const currentTarget=radiatorAvailable&&typeof reportedTarget==='number'&&Number.isFinite(reportedTarget)&&['°C','°F'].includes(unit)?unit==='°F'?(reportedTarget-32)*5/9:reportedTarget:null;
    return {...room,heatControl,heatingTarget,controlDeficit,sunCompensation,coasting,measurements,sourceAt,sensorFingerprint:JSON.stringify(readings.map(r=>r.entityId).sort()),sensorEntities:selectedEntities,sensorCount:selectedEntities.length,sensorCountUsed:readings.length,current,target,priority,effectiveWeight:scheduled?1:room.weight*priority,occupied,presence,reason,fresh:current !== null,deficit,callingForHeat,radiator:room.radiatorEntity?{entityId:room.radiatorEntity,name:radiator?.attributes?.friendly_name || room.radiatorEntity,available:radiatorAvailable,currentTarget,currentTemperature:temperature(radiator,now,maxAge,true,temperatureUnit),mode:radiatorAvailable?radiator.state:null,action:radiatorAvailable?radiator.attributes?.hvac_action || null:null,usedInAverage:selectedEntities.includes(room.radiatorEntity),target,preview:config.thermostat?.mode!=='active'}:null};
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

export function heatingSummary({store,ha,gasBudget},now=Date.now(),config=store.config()) {
  const rooms = store.list('rooms');
  const live = ha.status.connected && now-Date.parse(ha.status.fetchedAt)<=45000;
  const data=evaluateHeating({rooms,rules:store.list('rules'),states:live?ha.states:[],config,now,presenceMemory:ha.presenceMemory ||= new Map(),occupancyMemory:ha.occupancyMemory ||= {},temperatureUnit:ha.temperatureUnit,demandMemory:ha.demandMemory ||= new Map()});
  const budget=gasBudget?.status(now);data.budget=budget || null;
  const emergencyMemory=ha.budgetEmergencyMemory ||= new Map();
  if(budget?.settings.enabled&&data.smartPlan){
    const threshold=budget.settings.emergencyTempC ?? 7,target=threshold+0.5;
    const retained=new Map();
    data.rooms=data.rooms.map(room=>{
      const key=JSON.stringify([threshold,room.sensorEntities,room.sensorFreshnessMinutes]);
      const emergency=room.fresh&&(room.current<threshold||emergencyMemory.get(room.id)===key&&room.current<target);
      if(!emergency)return budget.paused?{...room,budgetPaused:true}:room;
      retained.set(room.id,key);
      if(!budget.paused&&room.callingForHeat&&room.heatingTarget>=target)return room;
      // Emergency demand warms cold rooms to the recovery temperature.
      // Solar estimates and comfort coasting must not suppress this demand.
      return {...room,emergencyHeating:true,budgetPaused:false,scheduledTarget:room.target,target,heatingTarget:target,
        deficit:target-room.current,controlDeficit:target-room.current,callingForHeat:true,coasting:false,
        heatControl:{...room.heatControl,startBelow:0.5,stopBelow:0},
        sunCompensation:{...room.sunCompensation,status:'frost',reductionC:0,heatingTargetC:target},
        radiator:room.radiator?{...room.radiator,target}:null,
        reason:`${room.name} is ${room.current.toFixed(1)}°C; emergency heating to ${target}°C${budget.paused?' overrides the gas budget pause.':'.'}`};
    });
    emergencyMemory.clear();for(const [id,key] of retained)emergencyMemory.set(id,key);
    const emergencyRooms=data.rooms.filter(room=>room.emergencyHeating);
    data.demandingRoomCount=data.rooms.filter(room=>room.fresh&&room.callingForHeat&&!room.budgetPaused).length;
    if(emergencyRooms.length){
      data.smartPlan={...smartThermostatPlan(data.rooms,config.heatingPlan,ha.states,now),planningOnly:data.smartPlan.planningOnly};
      if(budget.paused)data.budget={...budget,frostOverride:true,emergencyOverride:true,emergencyRoomIds:emergencyRooms.map(room=>room.id),pauseReason:budget.reason,reason:data.smartPlan.reason};
    }else if(budget.paused){
      data.smartPlan={...data.smartPlan,heat:false,flowC:0,kind:'budget',leadRoomId:null,reason:budget.reason};
    }
    data.controlRoomId=data.smartPlan.leadRoomId;
  }else{
    emergencyMemory.clear();
  }
  if(config.thermostat?.mode==='active'&&data.smartPlan){
    const overrides=new Map(rooms.filter(room=>room.radiatorEntity&&room.radiatorOverride?.until>now).map(room=>[room.id,room.radiatorOverride]));
    let applied=false;
    data.rooms=data.rooms.map(room=>{
      const override=overrides.get(room.id);
      if(!override)return room;
      const paused=room.budgetPaused?'Gas budget paused':!room.fresh?'Waiting for room temperature':emergencyMemory.has(room.id)||room.current<7?'Frost protection':override.opening>0&&room.current>=28?'Room at 28°C limit':null;
      const updated={...room,radiatorOverride:{...override,paused},scheduledOpening:requestedOpening(room)};
      if(paused)return updated;
      applied=true;
      return {...updated,callingForHeat:override.opening>0,coasting:false};
    });
    if(applied){
      data.smartPlan={...smartThermostatPlan(data.rooms,config.heatingPlan,live?ha.states:[],now),planningOnly:false};
      data.controlRoomId=data.smartPlan.leadRoomId;
      data.demandingRoomCount=data.rooms.filter(room=>room.callingForHeat&&!room.budgetPaused).length;
    }
  }
  return data;
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
      const now=Date.now(),data=heatingSummary(context,now),control=context.thermostat.status(now,data);
      const trends=context.heatingHistory.trends(data.rooms);
      return {...data,outlook:context.heatingOutlook.read().summary,control,
       valveControlEnabled:control.active?control.ready:data.plan?.settings.version!==2&&data.rooms.some(room=>room.radiatorEntity&&room.radiatorMode&&room.radiatorMode!=='monitor'),
       rooms:data.rooms.map(room=>({...room,trend:trends[room.id],radiatorControl:room.radiator?context.radiators.status(room.id):null,valvePlan:control.valves.find(valve=>valve.roomId===room.id) || null})),
       controller:{message:control.active?control.reason:'Planning only; Local PID controls the boiler and radiator settings stay unchanged.'}};
    });
    route('POST','/api/heating/radiator',({body})=>{if(Object.keys(body).some(k=>!['roomId','mode'].includes(k)))throw new HttpError(400,'Only a room and radiator mode are supported.');return context.radiators.setMode(body.roomId,body.mode);});
    route('POST','/api/heating/radiator/override',({body})=>context.thermostat.setValveOverride(body));
    route('GET','/api/heating/history',({url})=>context.heatingHistory.chart(Number(url.searchParams.get('minutes') || 1440)));
    route('GET','/api/heating/insights',()=>context.heatingHistory.insights());
    route('GET','/api/heating/analysis',()=>({...context.heatingHistory.analysis(),outlook:context.heatingOutlook.read()}));
  },
};
