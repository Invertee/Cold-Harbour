import {localParts} from './time.js';
import {defaultWeatherPlan} from './smart-thermostat.js';

export const defaultHeatingPlan={version:2,weather:defaultWeatherPlan,houseTarget:20,awayTarget:16,scheduleOverride:null,manualActivity:'auto',occupancyMode:'auto',people:[],awayDelayMinutes:10,activities:[
 {id:'home',name:'At home',targetMode:'house',offset:0,rooms:{}},
 {id:'work',name:'Working',targetMode:'house',offset:0,rooms:{}},
 {id:'evening',name:'Unwinding',targetMode:'house',offset:0,rooms:{}},
 {id:'sleep',name:'Sleeping',targetMode:'house',offset:-3,rooms:{}},
 {id:'away',name:'Away',targetMode:'setback',offset:0,rooms:{}},
],timeline:Array.from({length:7},()=>[{start:0,activityId:'sleep'},{start:390,activityId:'home'},{start:540,activityId:'work'},{start:1050,activityId:'evening'},{start:1350,activityId:'sleep'}]),awayTimeline:Array.from({length:7},()=>[{start:0,activityId:'away'}])};

const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
function activeRule(rule,day,at){if(!rule.enabled)return false;const start=minute(rule.start),end=minute(rule.end);return start<end?rule.days.includes(day)&&at>=start&&at<end:rule.days.includes(day)&&at>=start||rule.days.includes((day+6)%7)&&at<end;}
export function migrateHeatingPlan(rooms,rules,activity='auto'){
 const plan=structuredClone(defaultHeatingPlan),signatures=new Map();plan.version=1;
 for(const profile of plan.activities.filter(p=>p.targetMode==='house'))for(const room of rooms){
  const match=rules.filter(r=>r.enabled&&r.activity===profile.id&&r.roomId===room.id).sort((a,b)=>b.priority-a.priority)[0];
  const target=match?.target ?? (profile.id==='sleep'?room.eco:room.comfort);
  profile.rooms[room.id]={offset:Math.round((target-room.comfort-profile.offset)*100)/100,priority:match?.priority || 1,...(match?{presenceSetback:false}:{})};
 }
 // Preserve each existing day's effective targets, including overnight rules.
 plan.timeline=Array.from({length:7},(_,day)=>{
  const slots=[];let previous='';
  for(let at=0;at<1440;at++){
   const matches=rules.filter(r=>activeRule(r,day,at)).sort((a,b)=>b.priority-a.priority),kind=matches[0]?.activity || 'home';
   const overrides={};
   for(const room of rooms){const match=matches.find(r=>r.roomId===room.id),target=match?.target ?? (kind==='sleep'?room.eco:room.comfort);overrides[room.id]={offset:Math.round((target-room.comfort)*100)/100,priority:match?.priority || 1,...(match?{presenceSetback:false}:{})};}
   const signature=JSON.stringify([kind,overrides]);let id=signatures.get(signature);
   if(!id){id=`migrated_${signatures.size+1}`;signatures.set(signature,id);plan.activities.push({id,name:matches[0]?.name || 'Home routine',targetMode:'house',offset:0,rooms:overrides});}
   if(id!==previous){slots.push({start:at,activityId:id});previous=id;}
  }
  return slots;
 });
 if(activity!=='auto'&&plan.activities.some(p=>p.id===activity))plan.manualActivity=activity;
 return plan;
}

export function upgradeHeatingPlan(previous,rooms){
 const plan=structuredClone(previous);plan.version=2;plan.manualActivity='auto';plan.weather={...defaultWeatherPlan,...plan.weather};
 for(const profile of plan.activities){
  profile.offset=0;
  profile.rooms=Object.fromEntries(rooms.map(room=>[room.id,{offset:0,priority:profile.targetMode==='setback'?'low':profile.rooms[room.id]?.priority==='high'||Number(profile.rooms[room.id]?.priority)>=3?'high':'low'}]));
 }
 return plan;
}

export function groupHeatingSchedules(previous){
 const plan=structuredClone(previous);
 if(plan.version!==2)return plan;
 // Monday and Saturday represent the two editable groups. Archive the original
 // day-specific records in the database migration before applying this change.
 for(const key of ['timeline','awayTimeline'])for(const days of [[1,2,3,4,5],[6,0]]){
  const slots=structuredClone(plan[key][days[0]]);
  for(const day of days)plan[key][day]=structuredClone(slots);
 }
 return plan;
}

export function scheduledRoomTarget(room,priority,settings,profile={}){
 const comfort=Math.max(7,Math.min(28,(profile.houseTarget ?? settings.houseTarget)+(room.targetOffset ?? room.comfort-20)));
 return priority==='high'?comfort:Math.max(7,Math.min(comfort,settings.awayTarget+(room.awayOffset ?? room.eco-16)));
}

export function householdOccupancy(plan,states,now,memory){
 const byId=new Map(states.map(s=>[s.entity_id,s]));
 const people=plan.people.map(person=>{const state=byId.get(person.entityId),value=state?.state;return {...person,name:person.name || state?.attributes?.friendly_name || person.entityId,status:!value||['unknown','unavailable'].includes(value)?'unknown':value==='home'?'home':'away'};});
 const fingerprint=JSON.stringify([plan.people,plan.occupancyMode,plan.awayDelayMinutes]);
 if(memory.fingerprint!==fingerprint){memory.fingerprint=fingerprint;delete memory.awaySince;}
 const observed=people.some(p=>p.status==='home')?'home':!people.length?'unconfigured':people.some(p=>p.status==='unknown')?'unknown':'away';
 if(observed!=='away')delete memory.awaySince;
 else if(!Number.isFinite(memory.awaySince)||now<memory.awaySince)memory.awaySince=now;
 const held=observed==='away'&&now-memory.awaySince<plan.awayDelayMinutes*60000;
 const effective=plan.occupancyMode!=='auto'?plan.occupancyMode:observed==='away'&&!held?'away':'home';
 return {observed,effective,held,people,override:plan.occupancyMode!=='auto',remainingMinutes:held?Math.ceil((plan.awayDelayMinutes*60000-now+memory.awaySince)/60000):0};
}

export function resolveHeatingPlan(plan,states,now,timezone,memory={}){
 const occupancy=householdOccupancy(plan,states,now,memory),parts=localParts(new Date(now),timezone),day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday),at=Number(parts.hour)*60+Number(parts.minute);
 const scheduleDay=plan.version===2?(day===0||day===6?6:1):day;
 const slots=(occupancy.effective==='away'?plan.awayTimeline:plan.timeline)[scheduleDay];
 const automatic=plan.version===2||plan.manualActivity==='auto';
 const override=plan.version===2&&plan.scheduleOverride&&states.some(s=>s.entity_id===plan.scheduleOverride.entityId&&s.state==='on')?plan.scheduleOverride:null;
 const slot=[...slots].reverse().find(s=>s.start<=at),profile=plan.activities.find(p=>p.id===(override?.activityId ?? (automatic?slot.activityId:plan.manualActivity))) || plan.activities[0];
 const baseTarget=plan.version===2?(profile.houseTarget ?? plan.houseTarget):profile.targetMode==='setback'?plan.awayTarget:plan.houseTarget;
 return {profile,occupancy,day,minute:at,slot,baseTarget,activeTarget:Math.max(5,Math.min(28,baseTarget+(plan.version===2?0:profile.offset))),automatic,...(override?{override}:{})};
}
