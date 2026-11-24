import {api,dialog,esc,fixed,pill,select,toast} from '../ui.js';

export function thermostatMarkup(status){
 const waiting=status.checks.filter(check=>!check.ok);
 return `<h2>Smart Thermostat</h2>
 <form id="thermostat-control-form">
  ${select('Operation','mode',[['planning','Planning · monitor and calculate'],['active','Active · control boiler and radiators']],status.mode)}
  <div class="form-actions"><button class="button" type="submit">Save operating mode</button></div>
  <p class="form-error" role="alert"></p>
 </form>
 <h3>Readiness for Active</h3>
 ${waiting.length?`<ul class="commissioning-checks">${waiting.map(c=>`<li>${pill('Waiting','amber')}<span>${esc(c.detail)}</span></li>`).join('')}</ul>`:`<p role="status">${esc(status.active?status.reason:'Ready to select Active')}</p>`}
 ${status.valves.length?`<h3>Radiators</h3><div class="table-scroll"><table><thead><tr><th>Valve</th><th>Target opening</th><th>Device target</th><th>Status</th></tr></thead><tbody>
  ${status.valves.map(v=>`<tr><td>${esc(v.entityId)}</td><td>${v.opening}%</td><td>${fixed(v.deviceTarget)}°C</td><td>${esc(v.error || v.detail)}</td></tr>`).join('')}
 </tbody></table></div>`:''}
 <details class="advanced"><summary>Valve setup & fallback</summary>
  <p class="field-help">Enable both Valve degree entities and Adaptive mode in ZHA.</p>
  <p class="field-help">The device target can rise up to 5°C above the heating target. Fallback has no automatic TRV reset.</p>
 </details>`;
}
export function bindThermostat(ctx){
 const button=document.querySelector('#edit-thermostat');if(!button)return;
 button.onclick=async()=>{
  try{
   const status=await api('heating/control'),editor=dialog(thermostatMarkup(status));
   const form=document.querySelector('#thermostat-control-form');
   form.onsubmit=async event=>{
    event.preventDefault();const submit=form.querySelector('button[type="submit"]');submit.disabled=true;
    try{const result=await api('heating/control',{method:'POST',body:JSON.stringify({mode:form.elements.mode.value})});editor.close();await ctx.reload();toast(result.mode==='planning'?'Planning selected.':'Active selected.');}
    catch(error){form.querySelector('.form-error').textContent=error.message;submit.disabled=false;}
   };
  }catch(error){toast(error.message,true);}
 };
}
