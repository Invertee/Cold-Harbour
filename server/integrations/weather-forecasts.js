const celsius=(value,unit)=>typeof value==='number'&&Number.isFinite(value)?unit==='°C'?value:unit==='°F'?(value-32)*5/9:null:null;
export function normaliseForecast(response,entityId,kind,unit,now=Date.now()){
 const entries=response?.service_response?.[entityId]?.forecast;
 if(!Array.isArray(entries))throw new Error('Missing forecast response.');
 const rows=new Map();
 for(const entry of entries.slice(0,500)){
  if(!entry||typeof entry.datetime!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/i.test(entry.datetime))continue;
  const at=Date.parse(entry.datetime),temperature=celsius(entry.temperature,unit),low=celsius(entry.templow,unit);
  if(!Number.isFinite(at)||at<now-(kind==='daily'?36:2)*3600000||at>now+8*86400000||temperature===null||temperature<-60||temperature>60)continue;
  if(entry.templow!==undefined&&(low===null||low<-60||low>temperature))continue;
  rows.set(at,{at:new Date(at).toISOString(),temperatureC:temperature,lowC:kind==='daily'?low:null,condition:typeof entry.condition==='string'?entry.condition.slice(0,60):null});
 }
 return [...rows.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(0,kind==='daily'?9:192);
}

// The only action supported here retrieves forecast data. No caller can supply
// a service name, arbitrary target, or heating command.
export function createWeatherForecasts({source,request}){
 let signature='',cache={},pending=null;
 const current=()=>{const s=source();return {...s,signature:JSON.stringify([s.generation,s.entityId,s.unit,s.enabled])};};
 const reset=s=>{if(s.signature!==signature){signature=s.signature;cache={};}};
 return {
  clear(){signature='';cache={};},
  status(now=Date.now()){
   const s=current();reset(s);
   const configured=/^weather\.[a-z0-9_]+$/.test(s.entityId || ''),unitError=s.enabled&&configured&&s.connected&&!['°C','°F'].includes(s.unit)?'Weather temperature units are unavailable; check the entity and Home Assistant connection.':null;
   const kind=name=>{const value=cache[name] || {},fresh=Boolean(value.points?.length&&value.fetchedAt&&now-Date.parse(value.fetchedAt)<(name==='hourly'?2:12)*3600000&&now>=Date.parse(value.fetchedAt));return {points:value.points || [],fetchedAt:value.fetchedAt || null,fresh,error:value.error || unitError};};
   return {enabled:Boolean(s.enabled),entityId:s.entityId || '',configured,refreshing:pending?.signature===signature,connected:s.connected,hourly:kind('hourly'),daily:kind('daily')};
  },
  async poll(now=Date.now()){
   const s=current();reset(s);
   if(!s.enabled||!s.connected||!s.url||!s.token||!/^weather\.[a-z0-9_]+$/.test(s.entityId || '')||!['°C','°F'].includes(s.unit))return;
   if(pending?.signature===signature)return pending.promise;
   const kinds=['hourly','daily'].filter(kind=>!cache[kind]?.attemptAt||now-cache[kind].attemptAt>=(cache[kind].error?5:30)*60000);
   if(!kinds.length)return;
   const run={signature};pending=run;
   run.promise=Promise.all(kinds.map(async kind=>{
    cache[kind]={...cache[kind],attemptAt:now};
    try{
     const response=await request(`${s.url}/api/services/weather/get_forecasts?return_response`,{method:'POST',headers:{Authorization:`Bearer ${s.token}`,'Content-Type':'application/json'},body:JSON.stringify({entity_id:s.entityId,type:kind})});
     const points=normaliseForecast(response,s.entityId,kind,s.unit,now);
     if(!points.length)throw new Error('No usable forecast points.');
     if(current().signature!==run.signature)return;
     cache[kind]={points,fetchedAt:new Date(now).toISOString(),attemptAt:now,error:null};
    }catch{
     if(current().signature===run.signature)cache[kind]={...cache[kind],attemptAt:now,error:`${kind==='hourly'?'Hourly':'Daily'} forecast unavailable. Check this weather entity’s support and Home Assistant permissions.`};
    }
   })).finally(()=>{if(pending===run)pending=null;});
   return run.promise;
  },
 };
}
