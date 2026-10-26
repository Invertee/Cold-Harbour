import {scheduledRoomTarget} from '../heating-plan.js';
import {defaultWeatherPlan,weatherFlow} from '../smart-thermostat.js';
import {predictWarmup} from './heating-learning.js';

export function forecastAt(points,at){
 const before=[...points].reverse().find(p=>Date.parse(p.at)<=at),after=points.find(p=>Date.parse(p.at)>=at);
 if(before&&Date.parse(before.at)===at)return before.temperatureC;
 if(!before||!after||Date.parse(after.at)-Date.parse(before.at)>90*60000)return null;
 const ratio=(at-Date.parse(before.at))/(Date.parse(after.at)-Date.parse(before.at));return before.temperatureC+(after.temperatureC-before.temperatureC)*ratio;
}

export function buildHeatingOutlook({data,settings,forecasts,learning,timezone,now=Date.now()}){
 const weather={...defaultWeatherPlan,...settings.weather},rooms=data.rooms;
 const hourly=forecasts?.enabled&&forecasts.hourly?.fresh?forecasts.hourly.points:[],daily=forecasts?.enabled&&forecasts.daily?.fresh?forecasts.daily.points:[];
 const format=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit'}),profiles=new Map(settings.activities.map(p=>[p.id,p]));
 const parts=at=>Object.fromEntries(format.formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 const dayInfo=at=>{const p=parts(at);return {day:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday),minute:Number(p.hour)*60+Number(p.minute),date:`${p.year}-${p.month}-${p.day}`};};
 const today=dayInfo(now).date;
 const slotsAt=(at,scenario)=>{const {day}=dayInfo(at);return settings[scenario==='home'?'timeline':'awayTimeline'][day===0||day===6?6:1];};
 const targetsAt=(at,scenario)=>{
  const slots=slotsAt(at,scenario),minute=dayInfo(at).minute,slot=[...slots].reverse().find(s=>s.start<=minute),profile=profiles.get(slot.activityId);
  return {period:profile.name,rooms:rooms.map(room=>{const priority=profile.rooms[room.id]?.priority || 'low';return {id:room.id,name:room.name,priority,targetC:scheduledRoomTarget(room,priority,settings,profile)};})};
 };
 const scenarios={};
 for(const scenario of ['home','away']){
  const hours=hourly.filter(p=>Date.parse(p.at)>=now&&Date.parse(p.at)<=now+72*3600000).map(p=>{const targets=targetsAt(Date.parse(p.at),scenario),target=targets.rooms.length?Math.max(...targets.rooms.map(r=>r.targetC)):settings.houseTarget;return {...p,flowGuideC:weatherFlow(target,p.temperatureC,weather),period:targets.period,rooms:targets.rooms};});
  const seenDays=new Set(),days=daily.filter(p=>{const date=dayInfo(Date.parse(p.at)).date;if(date<today||seenDays.has(date))return false;seenDays.add(date);return true;}).slice(0,7).map(p=>{
   const slots=slotsAt(Date.parse(p.at),scenario),roomHours=rooms.map(room=>({id:room.id,name:room.name,hours:slots.reduce((sum,slot,i)=>sum+(profiles.get(slot.activityId).rooms[room.id]?.priority==='high'?((slots[i+1]?.start ?? 1440)-slot.start)/60:0),0)}));
   const target=rooms.length?Math.max(...rooms.flatMap(room=>slots.map(slot=>{const profile=profiles.get(slot.activityId);return scheduledRoomTarget(room,profile.rooms[room.id]?.priority || 'low',settings,profile);}))):settings.houseTarget;
   return {...p,date:dayInfo(Date.parse(p.at)).date,flowLowC:weatherFlow(target,p.temperatureC,weather),flowHighC:Number.isFinite(p.lowC)?weatherFlow(target,p.lowC,weather):null,roomHours};
  });
  const readiness=[];let previous=targetsAt(now,scenario);
  for(let at=Math.floor(now/60000)*60000+60000;at<=now+48*3600000;at+=60000){
   const next=targetsAt(at,scenario);
   for(const target of next.rooms){
    const old=previous.rooms.find(r=>r.id===target.id);if(target.priority!=='high'||old?.priority==='high'&&target.targetC<=old.targetC)continue;
    const room=rooms.find(r=>r.id===target.id),outdoor=forecastAt(hourly,at),deficit=room.fresh?Math.max(0,target.targetC-room.current):null;
    const flow=outdoor!==null?Math.max(weather.minFlow,Math.min(weather.maxFlow,weatherFlow(target.targetC,outdoor,weather)+(deficit || 0)*weather.deficitGain)):null;
    const estimate=predictWarmup(learning.rooms.find(r=>r.id===room.id),room,outdoor,flow,weather.entityId || weather.forecastEntityId),minutes=estimate&&deficit!==null?Math.ceil(deficit*estimate.minutesPerC):null;
    const status=!room.fresh?'room_unavailable':outdoor===null?'forecast_unavailable':deficit<=0.2?'at_target_now':!estimate?'learning':minutes>weather.maxPreheatMinutes?'over_limit':at-minutes*60000<now?'start_window_passed':'estimated';
    readiness.push({roomId:room.id,name:room.name,readyAt:new Date(at).toISOString(),targetC:target.targetC,currentC:room.current,outdoorC:outdoor,flowGuideC:flow,minutes,status,startBy:status==='estimated'||status==='start_window_passed'?new Date(at-minutes*60000).toISOString():null,estimate});
   }
   previous=next;
  }
  scenarios[scenario]={hourly:hours,daily:days,readiness:readiness.slice(0,64),readinessTruncated:readiness.length>64};
 }
 return {planningOnly:true,generatedAt:new Date(now).toISOString(),activeScenario:data.plan.occupancy.effective,forecasts,scenarios,assumption:'Home and away are alternative schedule scenarios, not predictions of future occupancy. Start estimates use today’s room temperature; future cooling and solar gain are not simulated.',summary:{hourlyPoints:scenarios.home.hourly.length,dailyDays:scenarios.home.daily.length,weatherMatchedSessions:learning.rooms.reduce((sum,r)=>sum+(r.weather?.matchedSessions || 0),0)}};
}

export function createHeatingOutlook(context,summary){
 let cache=null;
 return {read(now=Date.now()){
  const settings=context.store.config().heatingPlan,data=summary(now),forecasts=context.ha.forecasts || {enabled:false,hourly:{fresh:false,points:[]},daily:{fresh:false,points:[]}},learning=context.heatingHistory.learning(now);
  const fingerprint=JSON.stringify([settings,context.store.config().general.timezone,forecasts,learning.samples,data.rooms.map(r=>[r.id,r.current,r.sensorFingerprint]),data.plan.occupancy.effective]);
  if(cache&&now-cache.at<60000&&cache.fingerprint===fingerprint)return cache.value;
  const value=buildHeatingOutlook({data,settings,forecasts,learning,timezone:context.store.config().general.timezone,now});cache={at:now,fingerprint,value};return value;
 }};
}
