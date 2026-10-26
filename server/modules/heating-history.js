import {valvePlan} from './thermostat.js';
import {HttpError} from '../http.js';
import {phaseBands} from './boiler-history.js';
import {weatherLearning} from './heating-learning.js';

export function warmupInsights(samples,rooms,now=Date.now()){
 const average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
 return rooms.map(room=>{
  const sessions=[],unique=new Set(),diagnostics={recordedSamples:samples.length,roomSamples:0,confirmedHeatingSamples:0,weatherMatchedSamples:0,lastRoomAt:null,lastHeatingAt:null,lastWeatherAt:null};let run=null,active=null;
  const finish=(ongoing=false)=>{
   if(!run||run.points.length<3){run=null;return;}
   const points=run.points,first=points[0],last=points.at(-1),minutes=(last.at-first.at)/60000,rise=last.value-first.value;
   if(minutes>=10&&minutes<=360&&rise>=0.2){
    const xs=points.map(p=>(p.at-first.at)/3600000),meanX=average(xs),meanY=average(points.map(p=>p.value));let numerator=0,denominator=0;
    points.forEach((p,i)=>{numerator+=(xs[i]-meanX)*(p.value-meanY);denominator+=(xs[i]-meanX)**2;});const rate=numerator/denominator;
    if(rate>=0.05&&rate<=6){
     const outdoors=points.filter(p=>Number.isFinite(p.outdoorC)),reached=points.find(p=>p.value>=run.target-0.2);
     sessions.push({start:new Date(first.at).toISOString(),end:new Date(last.at).toISOString(),minutes,rise,rate,readings:points.length,ongoing,initialC:first.value,finalC:last.value,targetC:run.target,minutesToTarget:first.value<run.target-0.2&&reached?(reached.at-first.at)/60000:null,meanOutdoorC:average(outdoors.map(p=>p.outdoorC)),weatherCoverage:outdoors.length/points.length,meanFlowC:average(points.map(p=>p.flowC).filter(Number.isFinite)),meanModulation:average(points.map(p=>p.modulation).filter(Number.isFinite)),sensorFingerprint:run.fingerprint,radiatorEntity:run.radiatorEntity,outdoorEntity:run.weatherSource});
    }
   }
   run=null;
  };
  for(const sample of samples){
   const reading=sample.rooms.find(r=>r.id===room.id),at=Date.parse(sample.at),sourceAt=Date.parse(reading?.sourceAt),outdoor=sample.boiler?.outdoor_kind==='reported'&&sample.boiler?.outdoor_entity&&Number.isFinite(sample.boiler?.outdoor_c)?sample.boiler.outdoor_c:null;
   if(Number.isFinite(reading?.current)){diagnostics.roomSamples++;diagnostics.lastRoomAt=sample.at;if(Number.isFinite(sourceAt))unique.add(`${reading.sensorFingerprint}:${sourceAt}`);}
   if(sample.heating&&Number.isFinite(reading?.current)){diagnostics.confirmedHeatingSamples++;diagnostics.lastHeatingAt=sample.at;if(outdoor!==null){diagnostics.weatherMatchedSamples++;diagnostics.lastWeatherAt=sample.at;}}
   if(!sample.heating||reading?.radiatorPaused===true||!Number.isFinite(reading?.current)||!Number.isFinite(sourceAt)||!reading?.sensorFingerprint){finish();continue;}
   const radiatorFingerprint=JSON.stringify([reading.radiatorEntity,reading.radiatorMode,reading.radiatorTarget]),weatherSource=sample.boiler?.outdoor_entity || null;
   if(run&&(at-run.lastAt>150000||run.fingerprint!==reading.sensorFingerprint||run.radiatorFingerprint!==radiatorFingerprint||run.weatherSource!==weatherSource||Math.abs(run.target-reading.target)>0.2))finish();
   const startRun=()=>({start:at,lastAt:at,target:reading.target,fingerprint:reading.sensorFingerprint,radiatorFingerprint,radiatorEntity:reading.radiatorEntity || '',weatherSource,points:[]});
   if(!run)run=startRun();run.lastAt=at;
   if(sourceAt<run.start-60000||sourceAt>at+60000)continue;
   const previous=run.points.at(-1);if(previous?.at===sourceAt)continue;
   if(previous&&(sourceAt<=previous.at||sourceAt-previous.at>15*60000)){finish();run=startRun();}
   run.points.push({at:sourceAt,value:reading.current,outdoorC:outdoor,flowC:sample.boiler?.flow_c ?? null,modulation:sample.boiler?.modulation_pct ?? null});
  }
  const ongoing=Boolean(run&&now-run.lastAt<=150000&&now>=run.lastAt);
  if(ongoing)active={since:new Date(run.start).toISOString(),minutes:(run.lastAt-run.start)/60000,sourceReadings:run.points.length,rise:run.points.length?run.points.at(-1).value-run.points[0].value:0};
  finish(ongoing);
  const minutes=sessions.reduce((sum,s)=>sum+s.minutes,0),rise=sessions.reduce((sum,s)=>sum+s.rise,0),targetTimes=sessions.map(s=>s.minutesToTarget).filter(Number.isFinite);
  diagnostics.distinctSourceReadings=unique.size;
  return {id:room.id,name:room.name,sessions:sessions.length,minutesPerC:rise>0?minutes/rise:null,degreesPerHour:minutes>0?rise/minutes*60:null,observedMinutes:minutes,temperatureRise:rise,latest:sessions.slice(-5).reverse(),status:sessions.length>=3?'observed':sessions.length?'early':'collecting',active,diagnostics,meanMinutesToTarget:average(targetTimes),weather:weatherLearning(sessions),evidence:sessions};
 });
}

export function createHeatingHistory(context,summary){
 const {store}=context;let cache=null;
 function read(start,end){return store.db.prepare('SELECT at,snapshot FROM heating_samples WHERE at>=? AND at<=? ORDER BY at LIMIT 129600').all(new Date(start).toISOString(),new Date(end).toISOString()).map(row=>({at:row.at,...JSON.parse(row.snapshot)}));}
 return {
  capture(now=Date.now()){
   const at=new Date(Math.floor(now/60000)*60000).toISOString();
   if(store.db.prepare('SELECT 1 FROM heating_samples WHERE at=?').get(at))return;
   const data=summary(now),status=context.boiler?.status(now),t=status?.connected?status.telemetry || {}:{};
   const heating=t.heating_sample_valid===true&&t.ch_active===true&&t.dhw_active===false&&t.boiler_fault===false&&t.opentherm_age_s<90;
   const snapshot={houseTarget:data.plan?.settings.houseTarget ?? null,activeTarget:data.plan?.activeTarget ?? null,activity:data.plan?.profile.name || data.activity,occupancy:data.plan?.occupancy.effective || 'unknown',heating,
    boiler:{planned_flow_c:data.smartPlan&&data.smartPlan.kind!=='unavailable'?data.smartPlan.flowC:null,outdoor_c:data.smartPlan?.weather.outdoor?.temperature ?? null,outdoor_at:data.smartPlan?.weather.outdoor?.at || null,outdoor_entity:data.smartPlan?.weather.outdoor?.entityId || null,outdoor_kind:data.smartPlan?.weather.outdoor?'reported':null,flow_c:t.heating_sample_valid===true?(t.ch_flow_c ?? t.flow_c ?? null):null,return_c:t.heating_sample_valid===true?(t.ch_return_c ?? t.return_c ?? null):null,weather_status:data.smartPlan?.weather.status || null,planned_reason:data.smartPlan?.reason || null,requested_flow_c:t.requested_flow_c ?? null,modulation_pct:t.modulation_pct ?? null,pid_output_pct:Number.isFinite(t.pid_output)?t.pid_output*100:null,pid_target_c:t.pid_target_c ?? null,pid_temperature_c:t.pid_temperature_c ?? null,thermal_context:t.opentherm_age_s<90?t.thermal_context || 'unknown':'unknown'},
    rooms:data.rooms.map(({id,current,target,priority,sourceAt,sensorFingerprint,radiator,radiatorMode,...room})=>({id,current,target,priority,sourceAt,sensorFingerprint,...(radiator?{radiatorEntity:radiator.entityId,radiatorMode:radiatorMode || 'monitor',radiatorTarget:radiator.currentTarget,plannedOpening:valvePlan({...room,id,current,target,priority,radiator}).opening,radiatorReportedOpening:context.ha?.valveContext?.(radiator.entityId,now)?.opening?.value ?? null,radiatorPaused:context.ha?.valveContext?.(radiator.entityId,now)?.opening?.value===0||radiator.mode==='off'||data.plan?.settings.version!==2&&radiatorMode==='pause'}:{})}))};
   store.db.prepare('INSERT INTO heating_samples VALUES (?,?)').run(at,JSON.stringify(snapshot));
   store.db.prepare('DELETE FROM heating_samples WHERE at IN (SELECT at FROM heating_samples ORDER BY at DESC LIMIT -1 OFFSET 129600)').run();
  },
  chart(minutes=1440,now=Date.now()){
   if(![60,360,1440,10080].includes(minutes))throw new HttpError(400,'Choose 1 hour, 6 hours, 24 hours or 7 days.');
   const start=new Date(now-minutes*60000).toISOString(),end=new Date(now).toISOString(),samples=read(now-minutes*60000,now);
   const points=samples.map(s=>{const row={at:s.at,house_target_c:s.houseTarget,active_target_c:s.activeTarget,activity:s.activity,occupancy:s.occupancy,...s.boiler};for(const r of s.rooms){row[`room_${r.id}`]=r.current;row[`target_${r.id}`]=r.target;row[`priority_${r.id}`]=r.priority ?? null;row[`valve_${r.id}`]=r.plannedOpening ?? null;}return row;});
   return {start,end,points,rooms:store.list('rooms').map(({id,name})=>({id,name})),phaseBands:phaseBands(points,end),resolution:'One-minute observations · collection starts with this update'};
  },
  learning(now=Date.now()){
   const rooms=store.list('rooms'),fingerprint=JSON.stringify(rooms);
   if(cache&&now-cache.at<120000&&cache.fingerprint===fingerprint)return cache.value;
   const samples=read(now-30*86400000,now),value={days:30,firstSample:samples[0]?.at || null,samples:samples.length,rooms:warmupInsights(samples,rooms,now)};
   cache={at:now,fingerprint,value};return value;
  },
  insights(now=Date.now()){
   const value=this.learning(now);return {...value,rooms:value.rooms.map(({evidence,...room})=>room)};
  },
  analysis(now=Date.now()){
   const value=this.learning(now);return {...value,rooms:value.rooms.map(({evidence,...room})=>({...room,evidence:evidence.slice(-200)}))};
  },
 };
}
