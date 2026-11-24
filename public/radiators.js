import {api,dateTime,dialog,esc,fixed,input,select,toast,relative} from './ui.js';

const labels={heating:'Heating',idle:'Idle',off:'Off',heat:'Heat mode',auto:'Automatic',cooling:'Cooling'};
const setting=value=>Number.isFinite(value)?`${value}%`:'—';

export function radiatorCard(room,timezone){
 const {radiator,valvePlan:plan,radiatorOverride:override}=room;
 if(!radiator)return '';
 const state=radiator.available?radiator.action || radiator.mode:'unavailable';
 const stateLabel=labels[state] || (state==='unavailable'?'Unavailable':'Unknown');
 const until=override?` · Override until ${dateTime(override.until,timezone)}`:'';
 const waiting=room.fresh&&room.current<room.target&&plan?.opening===0&&Number.isFinite(plan.opensBelowC);
 const detail=override?.paused || plan?.blocked || plan?.error || (plan?.detail==='Settings confirmed'?null:plan?.detail) ||
  (waiting&&!override&&!room.budgetPaused?`Reopens below ${fixed(plan.opensBelowC,2)}°C`:null);
 return `<section class="room-valve" aria-label="Radiator valve">
  <div class="room-valve-heading"><strong>TRV · ${stateLabel}${until}</strong>
   ${plan?.canOverride||override?`<button type="button" class="text-link" data-valve-adjust="${esc(room.id)}" aria-label="Adjust ${esc(room.name)} valve">Adjust</button>`:''}
  </div>
  <small>${radiator.preview?'Planned':'Requested'} ${setting(plan?.opening)} · Reported setting ${setting(plan?.reportedOpening)}</small>
  ${detail?`<small>${esc(detail)}</small>`:''}
 </section>`;
}

export function bindRadiators(ctx,rooms){
 document.querySelectorAll('[data-radiator-monitor]').forEach(button=>button.onclick=async()=>{
  try{
   await api('heating/radiator',{method:'POST',body:JSON.stringify({roomId:button.dataset.radiatorMonitor,mode:'monitor'})});
   await ctx.reload();
   toast('Radiator set to Monitor.');
  }catch(error){toast(error.message,true);}
 });
 document.querySelectorAll('[data-valve-adjust]').forEach(button=>button.onclick=()=>{
  const room=rooms.find(room=>room.id===button.dataset.valveAdjust);
  const plan=room.valvePlan,override=room.radiatorOverride;
  const editor=dialog(`<h2>${esc(room.name)} valve</h2><form id="valve-override-form">
   <p class="field-help">Automatic opening ${setting(plan.scheduledOpening)}${plan.canOverride?' · 0% closes the valve':` · ${esc(plan.blocked)}`}</p>
   ${plan.canOverride?`<div class="form-grid">
    ${input('Temporary opening %','opening',override?.opening ?? plan.opening,'type="number" min="0" max="100" step="1" required')}
    ${select('Duration','minutes',[[15,'15 minutes'],[30,'30 minutes'],[60,'1 hour'],[120,'2 hours']],30)}
   </div>`:''}
   <div class="form-actions">
    ${override?'<button type="button" class="button secondary" data-valve-resume>Resume automatic</button>':''}
    ${plan.canOverride?'<button type="submit" class="button">Apply override</button>':''}
   </div><p class="form-error" role="alert"></p>
  </form>`);
  const form=editor.querySelector('#valve-override-form');
  const save=async values=>{
   const buttons=[...form.querySelectorAll('button')];
   buttons.forEach(button=>button.disabled=true);
   try{
    await api('heating/radiator/override',{method:'POST',body:JSON.stringify({roomId:room.id,...values})});
   }catch(error){
    form.querySelector('.form-error').textContent=error.message;
    buttons.forEach(button=>button.disabled=false);
    return;
   }
   editor.close();
   await ctx.reload();
   toast(values.opening===null?'Automatic valve control resumed.':'Valve override saved.');
  };
  form.onsubmit=event=>{
   event.preventDefault();
   if(plan.canOverride)void save({opening:Number(form.elements.opening.value),minutes:Number(form.elements.minutes.value)});
  };
  form.querySelector('[data-valve-resume]')?.addEventListener('click',()=>void save({opening:null}));
 });
}

export const measurementDetails=room=>`<details class="room-measurements"><summary>Temperature inputs · ${room.sensorCountUsed} of ${room.sensorCount} reporting</summary>${(room.measurements || []).map(source=>`<div><span>${esc(source.name)}${source.reportedAt?`<small title="${esc(source.reportedAt)}">Reported ${esc(relative(source.reportedAt))}</small>`:''}</span><strong>${source.value===null?({stale:'Stale',unavailable:'Unavailable',invalid:'Invalid reading'}[source.status] || 'Unavailable'):fixed(source.value)+'°C'}</strong></div>`).join('')}</details>`;
