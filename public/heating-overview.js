import {api,esc,fixed,icon,toast} from './ui.js';

export function heatingOverview(data,boiler){
  const plan=data.plan.settings,smart=data.smartPlan,active=data.control?.active,t=boiler.telemetry || {};
  const minimum=7,target=data.plan.activeTarget ?? plan.houseTarget;
  const arrow=up=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${up?'m6 15 6-6 6 6':'m6 9 6 6 6-6'}"/></svg>`;
  return `<section class="card heating-overview heating-hero" aria-label="Home climate">
    <div class="climate-heading"><span class="climate-eyebrow">${icon('heating')} Heating</span><h2>Home climate</h2><p class="climate-schedule">${icon(data.plan.occupancy.effective==='home'?'home':'moon')} ${data.plan.occupancy.effective==='home'?'Someone home':'Everyone away'}<span>·</span>${esc(data.plan.profile.name)}${data.plan.override?' · Sensor override':''}${data.plan.setpointOverride?' · Manual until next period':''}</p></div>
    <div class="climate-setpoint"><span class="climate-eyebrow">House setpoint</span><div class="climate-adjuster"><div class="climate-temperature"><span id="house-target-value" aria-live="polite">${fixed(target)}</span><span class="climate-unit">°C</span></div><div class="climate-stepper"><button type="button" data-setpoint-step="0.5" aria-label="Increase house setpoint" title="Increase by 0.5°C" ${target>=28?'disabled':''}>${arrow(true)}</button><button type="button" data-setpoint-step="-0.5" aria-label="Decrease house setpoint" title="Decrease by 0.5°C" ${target<=minimum?'disabled':''}>${arrow(false)}</button></div></div><span id="house-target-status" class="climate-save-status" role="status">${data.plan.setpointOverride?'Until next schedule period':''}</span></div>
    <div class="climate-status"><div class="climate-status-tags"><span class="climate-mode">${active?'Active':'Planning'}</span><span class="climate-controller"><i class="${boiler.connected?'':'offline'}"></i>${boiler.connected?t.remote_active?'Smart Thermostat':'Local PID':'Boiler offline'}</span></div><h3>${smart.kind==='unavailable'?'Waiting for readings':smart.heat?active?'Heat requested':'Heat planned':'Targets satisfied'}</h3><p class="climate-reason">${esc(smart.reason)}</p>${active&&!data.control?.ready?`<p class="climate-attention">${esc(data.control.reason)}</p>`:''}</div>
  </section>`;
}

export function bindHouseSetpoint(view,ctx,saveSetpoint=target=>api('heating/setpoint',{method:'POST',body:JSON.stringify({target})})){
  const root=document.querySelector('.heating-hero'),buttons=[...root.querySelectorAll('[data-setpoint-step]')],value=root.querySelector('#house-target-value'),status=root.querySelector('#house-target-status');
  let saving=false;
  const update=()=>buttons.forEach(button=>{const target=view.data.plan.activeTarget ?? view.data.plan.settings.houseTarget,next=Math.round((target+Number(button.dataset.setpointStep))*10)/10;button.disabled=saving||next<7||next>28;});
  buttons.forEach(button=>button.onclick=async()=>{
    if(saving||button.disabled)return;
    const previous=view.data.plan.activeTarget ?? view.data.plan.settings.houseTarget,next=Math.round((previous+Number(button.dataset.setpointStep))*10)/10;
    if(next<7||next>28)return;
    saving=true;root.dataset.interacting='true';value.textContent=fixed(next);status.textContent='Saving…';update();
    try{
      const saved=await saveSetpoint(next);view.data.plan=saved.plan;status.textContent='Until next schedule period';
    }catch(error){value.textContent=fixed(previous);status.textContent='Not saved';toast(error.message,true);}
    finally{saving=false;root.dataset.interacting='false';update();}
    if(view.data.plan.activeTarget===next){try{await ctx.reload();}catch{status.textContent='Saved · refresh to update readings';}}
  });
  update();
}
