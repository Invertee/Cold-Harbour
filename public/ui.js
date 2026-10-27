export const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const fixed = (value,places=1)=>value === null || value === undefined || !Number.isFinite(Number(value))?'—':Number(value).toFixed(places);
export const money = value=>value === null || value === undefined?'—':new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(value);
export const relative = at=>{if(!at)return 'Waiting for data';const seconds=Math.max(0,(Date.now()-Date.parse(at))/1000);return seconds<60?'Just updated':seconds<3600?`${Math.floor(seconds/60)} min ago`:seconds<86400?`${Math.floor(seconds/3600)} hours ago`:`${Math.floor(seconds/86400)} days ago`;};
export const dateTime=(at,timezone='Europe/London',options={})=>at?new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'numeric',minute:'2-digit',...options,hour12:true}).format(new Date(at)):'—';
export const time = (at,timezone='Europe/London')=>dateTime(at,timezone);
export const clockTime=value=>{const [hour,minute]=value.split(':').map(Number);return `${hour%12 || 12}:${String(minute).padStart(2,'0')} ${hour<12?'am':'pm'}`;};
export const clockValue=(hour,minute,period)=>`${String(Number(hour)%12+(period==='pm'?12:0)).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
export function clockInput(label,name,value){
  const [hour,minute]=value.split(':').map(Number);
  return `<fieldset class="clock-field"><legend>${esc(label)}</legend><div data-clock-input><input type="hidden" name="${esc(name)}" value="${esc(value)}"><select data-clock-part="hour" aria-label="${esc(label)} hour">${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${(hour%12 || 12)===i+1?'selected':''}>${i+1}</option>`).join('')}</select><span>:</span><select data-clock-part="minute" aria-label="${esc(label)} minute">${Array.from({length:60},(_,i)=>`<option value="${i}" ${minute===i?'selected':''}>${String(i).padStart(2,'0')}</option>`).join('')}</select><select data-clock-part="period" aria-label="${esc(label)} am or pm"><option value="am" ${hour<12?'selected':''}>am</option><option value="pm" ${hour>=12?'selected':''}>pm</option></select></div></fieldset>`;
}
export function bindClockInputs(form){for(const input of form.querySelectorAll('[data-clock-input]'))input.onchange=()=>{const part=name=>input.querySelector(`[data-clock-part="${name}"]`).value;input.querySelector('input').value=clockValue(part('hour'),part('minute'),part('period'));};}
export const icons = {
 settings:'<path d="m9 3 1-1h4l1 1 .5 2 2 .9 2-.5 2 3.4-1.5 1.5v2.4l1.5 1.5-2 3.4-2-.5-2 .9-.5 2-1 1h-4l-1-1-.5-2-2-.9-2 .5-2-3.4 1.5-1.5v-2.4L2 8.3l2-3.4 2 .5 2-.9z"/><circle cx="12" cy="11.5" r="3"/>',
 energy:'<path d="m13 2-3 8H5l6 4-1 8 9-12h-6z"/>',
 heating:'<path d="M9 14.5V5a3 3 0 0 1 6 0v9.5a5 5 0 1 1-6 0Z"/><path d="M12 9v8m0 0h.01"/>',
 entities:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 connections:'<path d="m8 12 4-4m-6 9-2 2m13-13 2-2M7 7l-3 3a4 4 0 0 0 0 6l1 1a4 4 0 0 0 6 0l3-3M10 10l3-3a4 4 0 0 1 6 0l1 1a4 4 0 0 1 0 6l-3 3"/>',
 activity:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
 arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
 refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 8a7 7 0 0 1 11.7-2L20 9M4 15l2.8 3A7 7 0 0 0 18.5 16"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 home:'<path d="m3 10 9-7 9 7v10H3zM9 20v-7h6v7"/>',
 sofa:'<path d="M5 12V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4M5 20v-2m14 2v-2M3 11h3v4h12v-4h3v7H3z"/>',
 desk:'<rect x="5" y="3" width="14" height="10" rx="1"/><path d="M12 13v4M8 17h8M3 17h18M5 17v4m14-4v4"/>',
 bed:'<path d="M3 19V8m18 11V8M3 16h18M5 12V6h14v6M3 12h18M7 9h3m4 0h3"/>',
 cup:'<path d="M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zm12 1h2a3 3 0 0 1 0 6h-2M7 2v3m5-3v3"/>',
 shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 edit:'<path d="m14 5 5 5M4 20l1-6L16 3l5 5-11 11z"/>',
 search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
 moon:'<path d="M20 13A8 8 0 0 1 11 4a8.5 8.5 0 1 0 9 9Z"/>',
 octopus:'<path d="M6 14V9a6 6 0 0 1 12 0v5M3 17c0 4 4 4 4 0v-3 4c0 3 5 3 5 0v-4 4c0 3 5 3 5 0v-4 3c0 4 4 4 4 0M9 9h.01M15 9h.01"/>',
};
export const icon = (name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.home}</svg>`;
export const pill = (text,kind='')=>`<span class="pill ${kind}"><span class="status-dot"></span>${esc(text)}</span>`;
export const empty = (title,description,link='')=>`<div class="empty-state"><strong>${title}</strong>${description?`<p>${description}</p>`:''}${link}</div>`;
export function toast(message,error=false) { const el=document.querySelector('#toast');el.textContent=message;el.className=`visible ${error?'error':''}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='',5000); }
export async function api(path,options={}) {
  const reading=(options.method || 'GET').toUpperCase()==='GET';
  const temporary=status=>[408,429,500,502,503,504].includes(status);
  const failure=(message,retryable=false)=>Object.assign(new Error(message),{retryable});
  for(let attempt=0;attempt<(reading?2:1);attempt++){
    try{
      let response;
      const timeout=AbortSignal.timeout(20000),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
      try{response=await fetch(new URL(`api/${path}`,new URL('./',location.href)),{...options,signal,headers:{'Content-Type':'application/json','X-MODS-Request':'1',...options.headers}});}
      catch{
        if(options.signal?.aborted)throw failure('Request cancelled.');
        throw failure(reading?'Connection interrupted. Please try again.':'Connection interrupted. Check whether your change was saved before trying again.',true);
      }
      let result;
      try{result=await response.json();if(!result||typeof result!=='object')throw new Error();}
      catch{
        if(options.signal?.aborted)throw failure('Request cancelled.');
        const message=response.status===401||response.status===403?'Access to Cold Harbour has expired or was denied. Reopen it from Home Assistant and try again.':response.ok||temporary(response.status)?'Cold Harbour is temporarily unavailable. Please try again.':`The request could not be completed (HTTP ${response.status}). Please try again.`;
        throw failure(message,response.ok||temporary(response.status));
      }
      if(!response.ok)throw failure(typeof result.error==='string'?result.error:`The request could not be completed (HTTP ${response.status}).`,temporary(response.status));
      return result;
    }catch(error){
      if(!reading||attempt===1||!error.retryable||options.signal?.aborted)throw error;
      await new Promise(resolve=>setTimeout(resolve,350));
    }
  }
}
export function dialog(html) {const el=document.querySelector('#editor');document.querySelector('#dialog-content').innerHTML=html;el.showModal();return el;}
export function fields(form) {return Object.fromEntries(new FormData(form));}
export function input(label,name,value='',options='') {return `<label>${label}<input name="${name}" value="${esc(value)}" ${options}></label>`;}
export function select(label,name,items,value='') {return `<label>${label}<select name="${name}">${items.map(item=>{const [id,text]=Array.isArray(item)?item:[item,item];return `<option value="${esc(id)}" ${value===id?'selected':''}>${esc(text)}</option>`;}).join('')}</select></label>`;}
export const entityOptions = (entities,domain,unit)=>[['','Choose an entity…'],...entities.filter(e=>e.entity_id.startsWith(domain+'.') && (!unit || unit.includes(e.attributes?.unit_of_measurement))).map(e=>[e.entity_id,`${e.attributes?.friendly_name || e.entity_id} · ${e.entity_id}`])];
