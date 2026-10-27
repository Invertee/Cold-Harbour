import {destroyCharts} from './charts.js';
import { modules } from './modules/registry.js';
import { api,icon,toast,esc,empty } from './ui.js';

const main=document.querySelector('#main');
let generation=0,currentModule=null,displayedModule=null,pendingRenders=0,connectionInterrupted=false;
const ctx={config:null,reload:()=>render()};
document.querySelector('#navigation').innerHTML=modules.map(module=>`<a href="#${module.id}" data-nav="${module.id}">${icon(module.icon)}<span>${module.label}</span></a>`).join('');
document.querySelector('#refresh').innerHTML=icon('refresh');

export async function render({background=false}={}) {
  if(background&&pendingRenders)return;
  pendingRenders++;
  const version=++generation;
  let id=location.hash.slice(1).split('/')[0] || 'boiler';
  if(['connections','entities'].includes(id)){history.replaceState(null,'',`#settings/${id}`);id='settings';}
  const module=modules.find(module=>module.id===id) || modules[0];
  if(displayedModule!==module.id){displayedModule=null;main.innerHTML='<div class="loading">Loading…</div>';document.querySelector('#connection-notice').hidden=true;}
  document.querySelectorAll('[data-nav]').forEach(link=>{const active=link.dataset.nav===module.id;link.classList.toggle('active',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  document.querySelector('#breadcrumb-current').textContent=module.label;
  document.title=`${module.label} · Cold Harbour`;
  try {
    ctx.config=await api('settings');
    if(version!==generation)return;
    const html=await module.render(ctx);
    if(version!==generation)return;
    destroyCharts();main.innerHTML=`<h1 class="sr-only">${esc(module.label)}</h1>${html}`;currentModule=module.id;displayedModule=module.id;module.bind?.(ctx);
    connectionInterrupted=false;document.querySelector('#connection-notice').hidden=true;
    document.querySelector('#system-status').textContent='Server online';
    const pill=document.querySelector('#mode-pill');pill.textContent=ctx.config.thermostat?.mode==='active'?'Smart Thermostat · Active selected':'Smart Thermostat · Planning';pill.className=ctx.config.thermostat?.mode==='active'?'pill amber':'pill green';pill.hidden=false;
    document.querySelector('#today').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:ctx.config.general.timezone,weekday:'short',day:'numeric',month:'short'}).format(new Date());
  }catch(err){
    if(version!==generation)return;
    connectionInterrupted=true;
    if(displayedModule===module.id){
      const notice=document.querySelector('#connection-notice');
      notice.innerHTML='<span>Updates paused. Showing previously loaded readings; they may be out of date. Retrying automatically.</span><button class="button secondary" id="retry">Try again</button>';notice.hidden=false;
    }else{
      displayedModule=null;destroyCharts();main.innerHTML=empty('Unable to load data',`${esc(err.message)} We’ll retry automatically.`,'<button class="button" id="retry">Try again</button>');
    }
    document.querySelector('#retry').onclick=()=>render();document.querySelector('#system-status').textContent='Connection interrupted';
  }finally{pendingRenders--;}
}
window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0});});
document.querySelector('.skip-link').onclick=event=>{event.preventDefault();main.focus();main.scrollIntoView();};
document.querySelector('#refresh').onclick=async event=>{const button=event.currentTarget;button.disabled=true;button.classList.add('spinning');try{await api('refresh',{method:'POST',body:'{}'});await render();toast('Home Assistant refreshed. ESP readings arrive every 30 seconds.');}catch(err){toast(err.message,true);}finally{button.disabled=false;button.classList.remove('spinning');}};
document.querySelector('#editor').addEventListener('click',event=>{if(event.target===event.currentTarget){const bounds=event.currentTarget.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)event.currentTarget.close();}});
window.addEventListener('unhandledrejection',event=>{toast(event.reason?.message || 'That action could not be completed.',true);event.preventDefault();});
setInterval(()=>{if(!document.hidden&&!document.querySelector('dialog[open],details[open],.interactive-chart[data-interacting="true"],.heating-hero[data-interacting="true"]')&&(currentModule!=='settings'||connectionInterrupted)&&(document.activeElement?.id==='retry'||!['INPUT','TEXTAREA','SELECT','BUTTON'].includes(document.activeElement?.tagName)))render({background:true});},15000);
render();
