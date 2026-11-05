import {api,dialog,esc,toast} from '../ui.js';
import {mountScheduleEditor,mountWeatherEditor} from './heating-controls.js';
import {mountHeatingAnalysis} from './heating-analysis.js';

const tabs=[['plan','Heating plan'],['observations','Observations'],['weather','Weather planning'],['forecast','Forecast']];

export function heatingDialogMarkup(selected='plan'){
 return `<div class="heating-workspace"><h2>Heating</h2><div class="heating-workspace-tabs" role="tablist" aria-label="Heating planning">${tabs.map(([id,label])=>`<button type="button" role="tab" id="heating-tab-${id}" aria-controls="heating-panel-${id}" aria-selected="${selected===id}" tabindex="${selected===id?0:-1}" data-heating-tab="${id}">${esc(label)}</button>`).join('')}</div><p class="field-help heating-draft-note">Switch tabs freely. Save heating plan applies schedule, gas budget and weather changes together.</p>${tabs.map(([id])=>`<section role="tabpanel" id="heating-panel-${id}" aria-labelledby="heating-tab-${id}" tabindex="0" data-heating-panel="${id}" ${selected===id?'':'hidden'}></section>`).join('')}</div>`;
}

export async function openHeatingDialog(ctx,{view,tab='plan',focus}={}){
 if(!tabs.some(([id])=>id===tab))tab='plan';
 const editor=dialog(heatingDialogMarkup(tab)),root=document.querySelector('#dialog-content'),panels=new Map(tabs.map(([id])=>[id,root.querySelector(`[data-heating-panel="${id}"]`)])),mounted=new Map();
 let disposed=false,saving=false,session=null,changed=false;
 editor.addEventListener('close',()=>{disposed=true;for(const panel of mounted.values())panel?.destroy?.();if(changed)void ctx.reload();},{once:true});
 const show=async selected=>{
  tab=selected;
  for(const [id,panel] of panels)panel.hidden=id!==tab;
  root.querySelectorAll('[data-heating-tab]').forEach(button=>{const active=button.dataset.heatingTab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
  editor.scrollTop=0;
  if(!session||disposed||mounted.has(tab))return;
  const panel=panels.get(tab);mounted.set(tab,null);
  if(tab==='plan')mountScheduleEditor(panel,session);
  else if(tab==='weather')mountWeatherEditor(panel,session);
  else{
   const id=tab,analysis=await mountHeatingAnalysis(ctx,{root:panel,editor,tab:id==='forecast'?'forecast':'learning'});
   if(disposed)analysis?.destroy();else mounted.set(id,analysis);
  }
 };
 root.querySelectorAll('[data-heating-tab]').forEach(button=>{
  button.onclick=()=>show(button.dataset.heatingTab);
  button.onkeydown=event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();const index=tabs.findIndex(([id])=>id===button.dataset.heatingTab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
   root.querySelector(`#heating-tab-${tabs[next][0]}`).focus();void show(tabs[next][0]);
  };
 });
 panels.get(tab).innerHTML='<p class="field-help">Loading heating plan…</p>';
 try{
  const [data,entityData]=await Promise.all([view?.data || api('heating'),api('entities').catch(()=>({entities:[]}))]);
  if(disposed)return;
  session={data,plan:structuredClone(data.plan.settings),budget:structuredClone(data.budget?.settings || ctx.config.gasBudget),rooms:data.rooms,entities:entityData.entities,save:async({nextTab=null}={})=>{
   if(saving||disposed)return;
   for(const id of ['plan','weather']){
    const form=panels.get(id).querySelector('form');
    if(form&&!form.checkValidity()){await show(id);form.reportValidity();return;}
   }
   saving=true;root.querySelectorAll('[data-heating-tab],button[type="submit"],.form-actions button').forEach(button=>button.disabled=true);
   const error=panels.get(tab).querySelector('.form-error');if(error)error.textContent='';
   try{
    const saved=await api('heating/plan',{method:'POST',body:JSON.stringify({heatingPlan:session.plan,gasBudget:session.budget})});
    if(disposed)return;
    ctx.config={...ctx.config,...saved};changed=true;toast('Heating plan saved.');
    if(nextTab){await show(nextTab);await mounted.get(nextTab)?.refresh?.();}else editor.close();
   }catch(failure){if(!disposed){if(error)error.textContent=failure.message;else toast(failure.message,true);}}
   finally{saving=false;if(!disposed)root.querySelectorAll('[data-heating-tab],button[type="submit"],.form-actions button').forEach(button=>button.disabled=false);}
  }};
  // A tab may have been selected while the plan was loading.
  await show(tab);
  if(focus&&!disposed){const target=root.querySelector(`#${focus}`);target?.scrollIntoView({block:'center'});target?.querySelector('input,select,button')?.focus();}
 }catch(error){if(!disposed){panels.get(tab).innerHTML=`<p class="form-error" role="alert">${esc(error.message)}</p>`;}}
 return editor;
}
