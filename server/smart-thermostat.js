// A planning model, deliberately separate from the signed boiler command path.
export const defaultWeatherPlan={enabled:false,entityId:'',forecastEntityId:'',staleMinutes:120,designOutdoor:-3,minFlow:35,maxFlow:52,deficitGain:5,maxPreheatMinutes:180};
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));

export function outdoorReading(settings,states,now){
 const entityId=settings.entityId || settings.forecastEntityId || '',state=states.find(s=>s.entity_id===entityId),weather=entityId.startsWith('weather.');
 if(!state||['unknown','unavailable',''].includes(state.state))return null;
 const value=weather?state.attributes?.temperature:state.state,unit=weather?state.attributes?.temperature_unit:state.attributes?.unit_of_measurement;
 const at=Date.parse(state.last_reported || state.last_updated);
 if(typeof value!=='number'&&typeof value!=='string'||String(value).trim()===''||!Number.isFinite(Number(value))||!['°C','°F'].includes(unit)||!Number.isFinite(at)||now-at>settings.staleMinutes*60000||at-now>60000)return null;
 const c=unit==='°F'?(Number(value)-32)*5/9:Number(value);
 return c>=-60&&c<=60?{temperature:c,at:new Date(at).toISOString(),entityId,name:state.attributes?.friendly_name || entityId}:null;
}

export function weatherFlow(target,outdoor,settings){
 const weather={...defaultWeatherPlan,...settings};
 return weather.minFlow+(weather.maxFlow-weather.minFlow)*clamp((target-outdoor)/(target-weather.designOutdoor),0,1);
}

export function smartThermostatPlan(rooms,settings,states,now){
 const weather={...defaultWeatherPlan,...settings.weather},outdoor=outdoorReading(weather,states,now);
 const usable=rooms.filter(r=>r.fresh),high=usable.filter(r=>r.priority==='high'&&r.callingForHeat),low=usable.filter(r=>r.priority==='low'&&r.callingForHeat);
 // Safety/setback demand is retained, but comfort demand from high rooms leads.
 const frost=usable.filter(r=>r.current<7),candidates=frost.length?frost:high.length?high:low;
 const lead=[...candidates].sort((a,b)=>(frost.length?a.current-b.current:b.deficit-a.deficit)||a.id.localeCompare(b.id))[0] || null;
 const kind=frost.length?'frost':high.length?'comfort':low.length?'setback':usable.length?'satisfied':'unavailable';
 const heat=Boolean(lead),target=lead?.target ?? settings.houseTarget;
 const load=weather.enabled&&outdoor?clamp((target-outdoor.temperature)/(target-weather.designOutdoor),0,1):null;
 const baseFlow=weather.minFlow+(weather.maxFlow-weather.minFlow)*(load ?? 0);
 const correction=heat?Math.max(0,lead.deficit)*weather.deficitGain:0;
 const flow=heat?Math.min(clamp(baseFlow+correction,weather.minFlow,weather.maxFlow),frost.length?40:weather.maxFlow):0;
 const reason=kind==='unavailable'?'No fresh room readings; Local PID remains the fallback.':kind==='satisfied'?'All reporting rooms have reached their scheduled targets.':kind==='frost'?`${lead.name} is below 7°C; room frost protection takes precedence.`:`${lead.name} is ${lead.deficit.toFixed(1)}°C below its ${kind==='comfort'?'high-priority':'low temperature'} target.`;
 return {planningOnly:true,mode:'Smart Thermostat',heat,kind,leadRoomId:lead?.id || null,reason,flowC:flow,highDemandCount:high.length,lowDemandCount:low.length,missingRooms:rooms.filter(r=>!r.fresh).map(r=>r.id),weather:{enabled:weather.enabled,status:!weather.enabled?'disabled':outdoor?'current':'unavailable',outdoor,loadFraction:load,baseFlowC:baseFlow,correctionC:correction,model:'Initial heating curve · not learned',fallback:weather.enabled&&!outdoor?'Weather unavailable; using the minimum flow plus room correction.':null}};
}
