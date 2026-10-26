import {api,esc,fixed,toast,relative} from './ui.js';
export function trvState(room){
 const radiator=room.radiator;
 if(!radiator)return '';
 const state=!radiator.available?'Unavailable':radiator.action || radiator.mode || 'Unknown';
 const labels={heating:'Heating',idle:'Idle',off:'Off',heat:'Heat mode',auto:'Automatic',cooling:'Cooling'};
 return `<p class="field-help">TRV: ${esc(labels[state] || state)}</p>`;
}
export function radiatorCard(room){
 const radiator=room.radiator,control=room.radiatorControl;
 if(!radiator)return '';
 const mode=control?.mode || 'monitor';
 return `<strong>${esc(radiator.name)}</strong><small>Measured ${fixed(radiator.currentTemperature)}°C · device target ${fixed(radiator.currentTarget)}°C</small><small>${radiator.available?`${esc(radiator.mode || 'Mode not reported')}${radiator.action?` · ${esc(radiator.action)}`:''}`:'Valve unavailable'} · planned ${fixed(room.target)}°C</small><small>${radiator.usedInAverage?'TRV temperature included in room average':'TRV temperature not included in room average'}</small><small>Planned opening ${room.valvePlan?.opening ?? 0}% · room target ${fixed(room.target)}°C</small>${mode!=='monitor'?`<small>Previous ${esc(mode)} automation paused while planning.</small><button class="text-link" data-radiator-monitor="${esc(room.id)}">Clear previous radiator mode</button>`:''}`;
}
export function bindRadiators(ctx){
 document.querySelectorAll('[data-radiator-monitor]').forEach(button=>button.onclick=async()=>{try{await api('heating/radiator',{method:'POST',body:JSON.stringify({roomId:button.dataset.radiatorMonitor,mode:'monitor'})});await ctx.reload();toast('Radiator remains in Monitor.');}catch(error){toast(error.message,true);}});
 document.querySelectorAll('[data-radiator-room]').forEach(select=>select.onchange=async()=>{
  select.disabled=true;
  try{await api('heating/radiator',{method:'POST',body:JSON.stringify({roomId:select.dataset.radiatorRoom,mode:select.value})});await ctx.reload();toast('Radiator mode updated. Boiler PID remains unchanged.');}
  catch(error){toast(error.message,true);await ctx.reload();}
 });
}
export const measurementDetails=room=>`<details class="room-measurements"><summary>Temperature inputs · ${room.sensorCountUsed} of ${room.sensorCount} reporting</summary>${(room.measurements || []).map(source=>`<div><span>${esc(source.name)}${source.kind==='thermostat'?' · TRV / thermostat':''}${source.reportedAt?`<small title="${esc(source.reportedAt)}">Last report: ${esc(relative(source.reportedAt))}</small>`:'<small>No report timestamp</small>'}${source.freshnessMinutes?`<small>Freshness limit: ${esc(source.freshnessMinutes)} min</small>`:''}</span><strong>${source.value===null?({stale:'Report too old',unavailable:'Unavailable',invalid:'Invalid reading'}[source.status] || 'Unavailable / stale'):fixed(source.value)+'°C'}</strong></div>`).join('')}</details>`;
