import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import { HttpError,json,readJson } from '../http.js';
import { heatingSummary } from './heating.js';
import { decodeFrame } from './opentherm.js';
import { chartReading,phaseBands } from './boiler-history.js';
import {exchangeHealth} from './exchange-health.js';
import {boilerEvents} from './boiler-events.js';

export const DEVICE_PORT=8102;
export const signPayload=(payload,key)=>createHmac('sha256',key).update(payload).digest('hex');
export const signedMessage=(value,key)=>{const payload=JSON.stringify(value);return {payload,signature:signPayload(payload,key)};};
const limits={local_temperature_c:[-30,60],pid_temperature_c:[-30,60],pid_target_c:[5,30],pid_output:[0,1],requested_flow_c:[0,80],flow_c:[0,120],return_c:[0,120],modulation_pct:[0,100],pressure_bar:[0,10],burner_starts:[0,1e9],burner_hours:[0,1e9],dhw_flow_l_min:[0,100],dhw_temperature_c:[0,120],dhw_setpoint_c:[0,127],ch_flow_c:[0,120],ch_return_c:[0,120],ch_modulation_pct:[0,100],protocol_revision:[1,2],min_flow_c:[30,65],max_flow_c:[30,65],lease_remaining_s:[0,90],free_heap_bytes:[0,1e8],exchange_failures:[0,1e9],opentherm_age_s:[0,1e8]};
const flags=['flame','ch_active','dhw_active','boiler_fault','frost_active','remote_active','comfort_enabled','pid_available','heating_sample_valid'];
const phases=['unknown','domestic_hot_water','settling_after_hot_water','space_heating','idle'];
function telemetry(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new HttpError(400,'Invalid telemetry.');
  const out={};
  for(const [name,[min,max]] of Object.entries(limits))if(value[name]!==undefined&&value[name]!==null){if(typeof value[name]!=='number'||!Number.isFinite(value[name])||value[name]<min||value[name]>max)throw new HttpError(400,`Invalid ${name}.`);out[name]=value[name];}
  for(const name of flags)if(value[name]!==undefined){if(typeof value[name]!=='boolean')throw new HttpError(400,`Invalid ${name}.`);out[name]=value[name];}
  if(typeof value.effective_mode==='string')out.effective_mode=value.effective_mode.slice(0,80);
  if(typeof value.pid_source==='string')out.pid_source=value.pid_source.slice(0,80);
  if(['wifi','ethernet'].includes(value.network_transport))out.network_transport=value.network_transport;
  if(value.thermal_context!==undefined&&!phases.includes(value.thermal_context))throw new HttpError(400,'Invalid thermal context.');
  out.thermal_context=out.dhw_active===true || out.dhw_flow_l_min>0.5?'domestic_hot_water':value.thermal_context || 'unknown';
  out.heating_sample_valid=out.thermal_context==='space_heating' && out.ch_active===true && out.dhw_active===false && out.opentherm_age_s<90 && out.heating_sample_valid===true;
  if(!out.heating_sample_valid)for(const name of ['ch_flow_c','ch_return_c','ch_modulation_pct'])delete out[name];
  return out;
}
export function createBoilerConnection(context) {
  const {store}=context;
  let lastPrune=0,captureRequest=null;const rejections=[];
  return {
    reset(){captureRequest=null;rejections.length=0;},
    status(now=Date.now()) {
      const config=store.config().boiler;
      const row=store.db.prepare('SELECT * FROM boiler_devices WHERE device_id=?').get(config.deviceId);
      const age=row?Math.max(0,(now-Date.parse(row.last_seen))/1000):null;
      return {mode:store.config().thermostat?.mode==='active'?'active':'listen',configured:Boolean(store.secret('boilerKey')),deviceId:config.deviceId,port:DEVICE_PORT,lastSeen:row?.last_seen || null,ageSeconds:age,connected:age!==null&&age<90,selectedMode:row?.mode || null,telemetry:row?JSON.parse(row.telemetry):null};
    },
    recordRejection(status,now=Date.now()){
      const at=Math.floor(now/60000)*60000,last=rejections.at(-1);
      if(last?.at===at&&last.status===status)last.count++;else rejections.push({at,status,count:1});
      while(rejections.length>100||rejections.length&&now-rejections[0].at>900000)rejections.shift();
    },
    exchangeHealth(now=Date.now()){
      const id=store.config().boiler.deviceId,start=new Date(now-900000).toISOString();
      const baseline=store.db.prepare('SELECT at,boot_id,telemetry FROM boiler_exchanges WHERE device_id=? AND at<? ORDER BY at DESC LIMIT 1').get(id,start);
      const rows=store.db.prepare('SELECT at,boot_id,telemetry FROM boiler_exchanges WHERE device_id=? AND at>=? ORDER BY at LIMIT 200').all(id,start);
      return exchangeHealth([...(baseline?[baseline]:[]),...rows].map(r=>({at:r.at,boot_id:r.boot_id,failures:JSON.parse(r.telemetry).exchange_failures})),now,rejections);
    },
    diagnostics(now=Date.now()) {
      const status=this.status(now),t=status.telemetry || {};
      const checks=[
        ['pairing','Controller paired',status.configured,'Create a controller key in Connections.'],
        ['connection','Signed readings arriving',status.connected,'Waiting for a signed exchange within the last 90 seconds.'],
        ['opentherm','OpenTherm feedback fresh',status.connected&&Number.isFinite(t.opentherm_age_s)&&t.opentherm_age_s<90,'Waiting for fresh boiler feedback.'],
        ['pid','Local PID ready',status.connected&&t.pid_available===true,'Check local Heat mode and temperature input on the ESP.'],
        ['fault','No reported boiler fault',status.connected&&t.boiler_fault===false,'Check boiler feedback and its local display.'],
        ['local',status.mode==='active'?'App authority reported':'Local authority',status.connected&&(status.mode==='active'?t.remote_active===true:t.remote_active===false&&t.lease_remaining_s===0),'Check the selected app operation, ESP mode and Active readiness. Planning releases any lease on the next signed exchange.'],
      ].map(([id,label,ok,detail])=>({id,label,ok:Boolean(ok),detail:ok?'Reported':detail}));
      return {status,checks,exchangeHealth:this.exchangeHealth(now),control:context.thermostat?.status(now),mode:status.mode,phase:t.thermal_context || 'unknown',homeAssistant:context.ha.status,rooms:heatingSummary(context,now).rooms.map(({id,name,current,target,fresh})=>({id,name,current,target,fresh})),retention:{historyDays:store.config().boiler.historyDays,exchangeDays:7,frameHours:24}};
    },
    pair() {
      captureRequest=null;
      const key=randomBytes(32).toString('hex');store.secret('boilerKey',key);
      store.db.prepare('DELETE FROM boiler_sessions').run();
      store.db.prepare('DELETE FROM boiler_devices WHERE device_id=?').run(store.config().boiler.deviceId);
      store.log('boiler','Controller pairing key created. Enter it in the ESPHome device’s Cold Harbour Pairing Key control.');
      return {key,deviceId:store.config().boiler.deviceId,port:DEVICE_PORT,path:'/v1/exchange'};
    },
    exchange(envelope,now=Date.now()) {
      const key=store.secret('boilerKey');
      if(!key || !envelope || typeof envelope.payload!=='string' || Buffer.byteLength(envelope.payload)>6144 || typeof envelope.signature!=='string' || !/^[a-f0-9]{64}$/.test(envelope.signature))throw new HttpError(401,'Invalid controller authentication.');
      if(!timingSafeEqual(Buffer.from(envelope.signature,'hex'),Buffer.from(signPayload(envelope.payload,key),'hex')))throw new HttpError(401,'Invalid controller authentication.');
      let message;try{message=JSON.parse(envelope.payload);}catch{throw new HttpError(400,'Invalid controller payload.');}
      const config=store.config(),boiler=config.boiler;
      if(!message || message.v!==1 || message.device_id!==boiler.deviceId || !/^[a-f0-9]{32}$/.test(message.boot_id) || !/^[a-f0-9]{16}$/.test(message.request_id) || !Number.isInteger(message.sequence) || message.sequence<1 || message.sequence>0xffffffff || !['PID','Cold Harbour'].includes(message.mode))throw new HttpError(400,'Invalid controller identity or sequence.');
      const last=store.db.prepare('SELECT sequence FROM boiler_sessions WHERE device_id=? AND boot_id=?').get(message.device_id,message.boot_id);
      if(last && message.sequence<=last.sequence)throw new HttpError(409,'Controller message already processed.');
      const device=store.db.prepare('SELECT * FROM boiler_devices WHERE device_id=?').get(message.device_id);
      if(device && now-Date.parse(device.last_seen)<5000)throw new HttpError(429,'Exchange no more than once every five seconds.');
      const values=telemetry(message.telemetry),capture=validateCapture(message.opentherm);
      if(capture)values.opentherm_capture={supported:true,active:capture.active,remaining_s:capture.remaining_s,overwritten:capture.overwritten,control_supported:capture.control_supported===true,last_control_id:capture.last_control_id || ''};
      const at=new Date(now).toISOString(),decision=heatingSummary(context,now);
      const command=context.thermostat?.response(decision,{connected:true,selectedMode:message.mode,telemetry:values},now) || {authority:'pid',enabled:false,flow_c:0,lease_s:0,reason:'Listen only; local ESP controller retains authority'};
      const response={v:1,device_id:message.device_id,boot_id:message.boot_id,request_id:message.request_id,sequence:message.sequence,...command};
      if(captureRequest){
        if(captureRequest.bootId!==message.boot_id||captureRequest.expiresAt<=now){captureRequest=null;}
        else if(capture?.last_control_id===captureRequest.id){
          if(captureRequest.state!=='confirmed')store.log('capture',`ESP confirmed capture ${captureRequest.action}.`);
          captureRequest.state='confirmed';
        }else if(captureRequest.state!=='confirmed'&&capture?.control_supported===true){
          if(response.authority==='remote')Object.assign(response,{authority:'observe',enabled:false,flow_c:0,lease_s:0});
          response.diagnostic_capture={id:captureRequest.id,action:captureRequest.action,duration_s:captureRequest.action==='start'?300:0};captureRequest.state='sent';
        }
      }
      store.db.exec('BEGIN');
      try {
        store.db.prepare('INSERT INTO boiler_sessions VALUES (?,?,?,?) ON CONFLICT(device_id,boot_id) DO UPDATE SET sequence=excluded.sequence,last_seen=excluded.last_seen').run(message.device_id,message.boot_id,message.sequence,at);
        store.db.prepare('INSERT INTO boiler_devices VALUES (?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen,mode=excluded.mode,telemetry=excluded.telemetry').run(message.device_id,at,message.mode,JSON.stringify(values));
        store.db.prepare('INSERT INTO boiler_exchanges VALUES (?,?,?,?,?,?)').run(message.device_id,message.boot_id,message.sequence,at,message.mode,JSON.stringify(values));
        const sample=store.db.prepare('SELECT at FROM boiler_samples WHERE device_id=? ORDER BY at DESC LIMIT 1').get(message.device_id);
        if(!sample || now-Date.parse(sample.at)>=60000)store.db.prepare('INSERT INTO boiler_samples VALUES (?,?,?)').run(message.device_id,at,JSON.stringify({...values,selected_mode:message.mode,app_mode:config.thermostat?.mode || 'planning',remote_granted:response.authority==='remote',rooms:decision.rooms.map(({id,current,target,priority,occupied})=>({id,current,target,priority,occupied}))}));
        if(capture)for(const [sequence,ageMs,tx,type,id,data] of capture.frames)store.db.prepare('INSERT OR IGNORE INTO boiler_frames VALUES (?,?,?,?,?,?,?,?,?)').run(message.device_id,message.boot_id,sequence,at,new Date(now-ageMs).toISOString(),tx?'tx':'rx',type,id,data);
        if(!device || now-Date.parse(device.last_seen)>=90000)store.log('boiler',`Signed ESP readings connected · ${config.thermostat?.mode || 'planning'}.`);
        if(device){const previous=JSON.parse(device.telemetry);for(const [field,label] of [['effective_mode','Controller'],['thermal_context','Boiler phase'],['boiler_fault','Boiler fault'],['frost_active','Frost protection']])if(values[field]!==undefined&&values[field]!==previous[field])store.log('boiler',`${label}: ${values[field]}`);}
        if(now-lastPrune>=3600000){
          store.db.prepare('DELETE FROM boiler_samples WHERE at<?').run(new Date(now-boiler.historyDays*86400000).toISOString());
          store.db.prepare('DELETE FROM boiler_sessions WHERE last_seen<?').run(new Date(now-boiler.historyDays*86400000).toISOString());
          store.db.prepare('DELETE FROM boiler_exchanges WHERE at<?').run(new Date(now-7*86400000).toISOString());
          store.db.prepare('DELETE FROM boiler_frames WHERE received_at<?').run(new Date(now-86400000).toISOString());lastPrune=now;
        }
        // Hard caps also bound storage if capture is repeatedly restarted.
        store.db.prepare('DELETE FROM boiler_frames WHERE rowid IN (SELECT rowid FROM boiler_frames ORDER BY received_at DESC,rowid DESC LIMIT -1 OFFSET 50000)').run();
        store.db.prepare('DELETE FROM boiler_exchanges WHERE rowid IN (SELECT rowid FROM boiler_exchanges ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 125000)').run();
        store.db.exec('COMMIT');
      } catch(err) {store.db.exec('ROLLBACK');throw err;}
      return signedMessage(response,key);
    },
    history(hours=24) {
      checkHours(hours,168);
      return store.db.prepare('SELECT at,telemetry FROM boiler_samples WHERE device_id=? AND at>=? ORDER BY at LIMIT 10080').all(store.config().boiler.deviceId,new Date(Date.now()-hours*3600000).toISOString()).map(row=>({at:row.at,...JSON.parse(row.telemetry)}));
    },
    captureStatus(now=Date.now()){
      const status=this.status(now),capture=status.telemetry?.opentherm_capture;
      if(captureRequest&&captureRequest.expiresAt<=now)captureRequest=null;
      if(capture?.control_supported===true)return {ready:status.connected,transport:'device',selected:null,candidates:[],automatic:true,request:captureRequest,error:status.connected?null:'Waiting for a fresh signed ESP exchange.'};
      const ha=context.ha.captureStatus?.() || {ready:false,candidates:[]};
      return {...ha,ready:status.connected&&Boolean(capture?.supported)&&ha.ready,transport:'homeAssistant',request:null,error:ha.ready?null:ha.error || 'Direct capture needs ESPHome component 0.8.0. The Home Assistant diagnostic switch can also be used.'};
    },
    async requestCapture(enabled,now=Date.now()){
      if(typeof enabled!=='boolean')throw new HttpError(400,'Choose capture start or stop.');
      const status=this.status(now),capture=status.telemetry?.opentherm_capture;
      if(!status.connected||!capture?.supported)throw new HttpError(409,'Wait for fresh capture-capable ESP telemetry.');
      if(!capture.control_supported)return context.ha.setMessageCapture(enabled);
      if(enabled&&(capture.active||captureRequest&&captureRequest.expiresAt>now&&captureRequest.action==='start'&&captureRequest.state!=='confirmed'))throw new HttpError(409,'Capture is already active or queued.');
      const boot=store.db.prepare('SELECT boot_id FROM boiler_exchanges WHERE device_id=? ORDER BY at DESC LIMIT 1').get(status.deviceId);
      if(!boot)throw new HttpError(409,'Waiting for the current ESP boot identity.');
      captureRequest={id:randomBytes(8).toString('hex'),action:enabled?'start':'stop',bootId:boot.boot_id,requestedAt:now,expiresAt:now+120000,state:'queued'};
      store.log('capture',`OpenTherm capture ${captureRequest.action} queued for the signed device connection.`);
      return {requested:true,transport:'device',message:enabled?'Five-minute capture queued. It starts on the next ESP exchange (normally within 30 seconds).':'Capture stop queued for the next ESP exchange.'};
    },
    chart(minutes=60,source='telemetry',now=Date.now()){
      if(![15,60,360,1440,10080].includes(minutes)||!['telemetry','opentherm'].includes(source))throw new HttpError(400,'Choose a supported chart range and source.');
      const end=new Date(now).toISOString(),start=new Date(now-minutes*60000).toISOString(),id=store.config().boiler.deviceId;
      let points=[],resolution='30-second device exchanges',truncated=false;
      const rows=store.db.prepare('SELECT at,telemetry FROM boiler_exchanges WHERE device_id=? AND at>=? AND at<=? ORDER BY at DESC LIMIT 125000').all(id,start,end);truncated=rows.length===125000;
      let readings=rows.reverse().map(row=>chartReading(row.at,JSON.parse(row.telemetry)));
      const archive=store.db.prepare('SELECT at,telemetry FROM boiler_samples WHERE device_id=? AND at>=? AND at<? ORDER BY at LIMIT 10080').all(id,start,readings[0]?.at || end).map(row=>chartReading(row.at,JSON.parse(row.telemetry)));
      if(archive.length){resolution=readings.length?'30-second exchanges · older one-minute archive':'Archived one-minute readings';readings=[...archive,...readings];}
      if(source==='telemetry')points=readings;
      else{
        const fields={1:'requested_flow_c',25:'flow_c',26:'dhw_temperature_c',28:'return_c'};
        const rows=store.db.prepare('SELECT at,direction,type,data_id,data FROM boiler_frames WHERE device_id=? AND received_at>=? AND at>=? AND at<=? AND data_id IN (1,25,26,28) AND (type=4 OR (data_id=1 AND type IN (1,5))) ORDER BY at DESC LIMIT 50000').all(id,start,start,end);truncated ||= rows.length===50000;
        points=rows.reverse().map(row=>{const frame=decodeFrame(row);return {at:row.at,[fields[row.data_id]]:frame.value,raw_id:row.data_id,raw_data:frame.dataHex,direction:row.direction};}).filter(row=>Object.values(fields).some(field=>Number.isFinite(row[field])));
        resolution='Captured messages · estimated bus times · retained for 24 hours';
      }
      return {mode:'listen',source,start,end,resolution,truncated,points,phaseBands:phaseBands(readings,end),...(source==='opentherm'?{heatingPoints:readings}:{})};
    },
    logs({kind='events',hours=24,limit=200}={}) {
      if(!['events','readings','opentherm'].includes(kind))throw new HttpError(400,'Choose events, readings or opentherm logs.');
      checkHours(hours,kind==='opentherm'?24:168);
      if(!Number.isInteger(limit)||limit<1||limit>5000)throw new HttpError(400,'Choose between 1 and 5000 log entries.');
      const since=new Date(Date.now()-hours*3600000).toISOString(),id=store.config().boiler.deviceId;
      if(kind==='events'){
        const decode=({telemetry,...row})=>({...row,telemetry:JSON.parse(telemetry)});
        const baseline=store.db.prepare('SELECT at,boot_id,sequence,mode,telemetry FROM boiler_exchanges WHERE device_id=? AND at<? ORDER BY at DESC,rowid DESC LIMIT 1').get(id,since);
        const readings=store.db.prepare('SELECT at,boot_id,sequence,mode,telemetry FROM boiler_exchanges WHERE device_id=? AND at>=? ORDER BY at,rowid LIMIT 125000').all(id,since).map(decode);
        return {mode:'listen',kind,deviceId:id,limit,retentionHours:168,rows:boilerEvents(readings,baseline?decode(baseline):null).slice(-limit).reverse()};
      }
      const rows=kind==='readings'?store.db.prepare('SELECT at,boot_id,sequence,mode,telemetry FROM boiler_exchanges WHERE device_id=? AND at>=? ORDER BY at DESC,sequence DESC LIMIT ?').all(id,since,limit).map(({telemetry,...row})=>({...row,telemetry:JSON.parse(telemetry)})):store.db.prepare('SELECT at,received_at,boot_id,sequence,direction,type,data_id,data FROM boiler_frames WHERE device_id=? AND received_at>=? ORDER BY received_at DESC,rowid DESC LIMIT ?').all(id,since,limit).map(decodeFrame);
      return {mode:'listen',kind,deviceId:id,limit,retentionHours:kind==='readings'?168:24,rows};
    },
  };
}
function checkHours(hours,max){if(!Number.isInteger(hours)||hours<1||hours>max)throw new HttpError(400,`Choose between 1 and ${max} hours.`);}
function validateCapture(value){
  if(value===undefined)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.active!=='boolean'||!Number.isInteger(value.remaining_s)||value.remaining_s<0||value.remaining_s>300||!Number.isInteger(value.overwritten)||value.overwritten<0||value.overwritten>0xffffffff||!Array.isArray(value.frames)||value.frames.length>64)throw new HttpError(400,'Invalid OpenTherm capture.');
  if(value.control_supported!==undefined&&typeof value.control_supported!=='boolean'||value.last_control_id!==undefined&&(typeof value.last_control_id!=='string'||!/^([a-f0-9]{16})?$/.test(value.last_control_id)))throw new HttpError(400,'Invalid capture control acknowledgement.');
  let previous=0;
  for(const frame of value.frames){
    const bounds=[[1,0xffffffff],[0,90000],[0,1],[0,7],[0,255],[0,65535]];
    if(!Array.isArray(frame)||frame.length!==6||frame.some((n,i)=>!Number.isInteger(n)||n<bounds[i][0]||n>bounds[i][1])||frame[0]<=previous)throw new HttpError(400,'Invalid OpenTherm frame.');
    previous=frame[0];
  }
  return value;
}
export function deviceHandler(context) {
  return async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if(req.method!=='POST' || req.url!=='/v1/exchange')throw new HttpError(404,'Device endpoint not found.');
      if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'Cross-site requests are not allowed.');
      const body=await readJson(req,8192);
      return json(res,context.boiler.exchange(body));
    }catch(err){context.boiler.recordRejection(err.status || 500);return json(res,{error:err.status?err.message:'Controller exchange failed.'},err.status || 500);}
  };
}
export const boilerModule={id:'boiler',name:'Boiler monitor',description:'Signed ESPHome exchanges, bounded thermostat leases, history and OpenTherm message capture.',register({route,context}){
  context.boiler=createBoilerConnection(context);
  route('GET','/api/boiler',()=>context.boiler.status());
  route('POST','/api/boiler/pair',()=>context.boiler.pair());
  route('GET','/api/boiler/history',({url})=>context.boiler.history(Number(url.searchParams.get('hours') || 24)));
  route('GET','/api/boiler/logs',({url})=>context.boiler.logs({kind:url.searchParams.get('kind') || 'events',hours:Number(url.searchParams.get('hours') || 24),limit:Number(url.searchParams.get('limit') || 200)}));
  route('GET','/api/boiler/diagnostics',()=>context.boiler.diagnostics());
  route('GET','/api/boiler/chart',({url})=>context.boiler.chart(Number(url.searchParams.get('minutes') || 60),url.searchParams.get('source') || 'telemetry'));
  route('GET','/api/boiler/capture',()=>context.boiler.captureStatus());
  route('POST','/api/boiler/capture',({body})=>{
    if(Object.keys(body).some(key=>key!=='enabled'))throw new HttpError(400,'Only a capture start/stop action is supported.');
    return context.boiler.requestCapture(body.enabled);
  });
}};
