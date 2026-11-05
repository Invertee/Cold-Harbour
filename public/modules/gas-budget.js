import {api,dialog,esc,fixed,money,relative,dateTime,input,select,toast,clockTime,clockInput,bindClockInputs} from '../ui.js';
import {chartShell,bindChart,chartColours} from '../charts.js';

const amount=(value,unit)=>unit==='cost'?money(value):`${fixed(value,1)} kWh`;
const clock=minute=>minute===1440?'24:00':`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const windowTime=minute=>minute===1440?'midnight':clockTime(clock(minute));
const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));

export function gasBudgetMarkup(data,active){
 if(!data)return '';
 const {settings:s}=data,at=s.unit==='cost'?data.costAt:data.usageAt;
 const state=!s.enabled?'Budget off':data.paused?(active?'Pause requested':'Pause planned'):s.action==='monitor'?'Monitoring only':data.fresh?'Budget control on':'Awaiting gas data';
 return `<section class="card gas-budget-card"><div class="section-heading"><div><h2>Gas today & heating budget</h2><p class="field-help">${esc(data.day)} · ${esc(state)}</p></div><button class="button secondary" id="edit-gas-budget">Set gas budget</button></div><div class="gas-budget-metrics"><div><span>Gas reported today</span><strong>${fixed(data.kwh,2)} kWh</strong><small>${data.usageFresh?'Source within freshness limit':'Reading unavailable or stale'} · ${relative(data.usageAt)}</small></div><div><span>Reported gas cost</span><strong>${money(data.cost)}</strong><small>${data.costFresh?'Source within freshness limit':'Reading unavailable or stale'} · ${relative(data.costAt)}</small></div><div><span>Daily budget</span><strong>${s.enabled?amount(s.dailyLimit,s.unit):'Not enabled'}</strong><small>${s.enabled?`${amount(data.remaining,s.unit)} remaining`:'Monitoring starts as daily readings arrive'}</small></div></div>${s.enabled?`<progress class="gas-budget-progress" max="1" value="${data.fraction ?? 0}" aria-label="Daily gas budget used"></progress><p role="status">${esc(data.reason)}</p>${s.periods.length?`<div class="gas-budget-windows">${s.periods.map(p=>`<div class="${p===data.allowance.current||p.start===data.allowance.current?.start?'current':''}"><strong>${esc(p.name)}</strong><span>${windowTime(p.start)}–${windowTime(p.end)}</span><span>${p.share}% · ${amount(s.dailyLimit*p.share/100,s.unit)}</span></div>`).join('')}</div><p class="field-help">${amount(data.allowance.limit,s.unit)} released so far. Unused allowance carries into later windows; heating pauses between windows when budget control is selected.</p>`:''}`:''}<p class="field-help">Latest ${s.unit==='cost'?'cost':'usage'} report: ${at?esc(dateTime(at,data.timezone,{day:'numeric',month:'short',second:'2-digit'})):'not available'}. Gas updates can be delayed by the meter or integration, so a cutoff can overshoot the budget. All household gas counts, including hot water; reported daily cost may include standing charges.</p>${chartShell('gas-day-chart','Reported gas use and cost throughout today')}<p class="field-help">Recorded daily totals, sampled while the server runs. Missing readings stay as gaps. Budget pauses apply in Smart Thermostat Active mode with healthy controller feedback; local fallback and frost protection keep their own controls.</p></section>`;
}

export function bindGasBudget(ctx,data,state={}){
 if(!data)return;
 const maxCost=Math.max(1,...data.points.map(p=>p.cost).filter(Number.isFinite))*1.1;
 bindChart(document.querySelector('#gas-day-chart'),{rows:data.points,start:data.start,end:data.end,timezone:data.timezone,unit:'kWh',maxGapMs:150000,state,
  rightUnit:'GBP',rightDomain:[0,maxCost],series:[{key:'kwh',label:'Gas today',colour:chartColours[2],digits:2},{key:'cost',label:'Reported daily cost',colour:chartColours[0],axis:'right',unit:'GBP',digits:2}],
  references:data.settings.enabled&&data.settings.unit==='kwh'?[{value:data.settings.dailyLimit,label:'Daily gas budget',colour:'#a45b38'}]:[],
  extraTooltip:row=>[['Gas source report',dateTime(row.usage_at,data.timezone)],['Cost source report',dateTime(row.cost_at,data.timezone)]],extraExport:[['usage_at','Usage source timestamp'],['cost_at','Cost source timestamp']]});
 document.querySelector('#edit-gas-budget').onclick=()=>editGasBudget(ctx,data);
}

export function gasBudgetEditor(settings){
 return `<h2>Daily gas & heating budget</h2><form id="gas-budget-form"><label class="check-label"><input type="checkbox" name="enabled" ${settings.enabled?'checked':''}> Enable gas budget</label><div class="form-grid">${select('Budget measured in','unit',[['kwh','Gas energy · kWh'],['cost','Reported gas cost · £']],settings.unit)}${input('Daily limit','dailyLimit',settings.dailyLimit,'type="number" min="0.01" max="10000" step="0.01" required')}${select('At the limit or outside a heating window','action',[['monitor','Show status only'],['pause','Pause heating in Active mode']],settings.action)}${input('Accept gas readings up to this age (minutes)','staleMinutes',settings.staleMinutes,'type="number" min="5" max="360" required')}</div><h3>Reserve budget for heating windows</h3><p class="field-help">Leave empty to allow heating all day. Add windows to reserve part of the daily budget for later. Shares must total 100%. A window releases its share at the start; unused allowance carries forward. All gas used since midnight counts against the released total.</p><div id="gas-budget-periods"></div><button class="button secondary" type="button" id="add-gas-window">Add heating window</button><div id="gas-budget-allocation" class="field-help" aria-live="polite"></div><p class="field-help">Cutoff uses the mapped daily kWh or cost sensor. A missing reading keeps heating available unless a recorded limit has already been reached or the current time is outside a configured window. The daily limit resets at midnight in your configured timezone. Local PID fallback and frost protection remain independent. Delayed meter data can allow additional use before cutoff.</p><div class="form-actions"><button class="button" type="submit">Save gas budget</button></div><p class="form-error" role="alert"></p></form>`;
}

function editGasBudget(ctx,data){
 const editor=dialog(gasBudgetEditor(data.settings)),form=document.querySelector('#gas-budget-form'),container=form.querySelector('#gas-budget-periods');
 const readPeriods=()=>[...container.children].map(row=>({name:row.querySelector('[name="windowName"]').value,start:minute(row.querySelector('[name="windowStart"]').value),end:row.querySelector('[name="windowMidnight"]').checked?1440:minute(row.querySelector('[name="windowEnd"]').value),share:Number(row.querySelector('[name="windowShare"]').value)})).sort((a,b)=>a.start-b.start);
 const update=()=>{
  const periods=readPeriods(),limit=Number(form.elements.dailyLimit.value),unit=form.elements.unit.value;
  form.querySelector('#gas-budget-allocation').textContent=periods.length?`${periods.reduce((sum,p)=>sum+p.share,0)}% allocated. ${periods.map(p=>`${p.name || 'Window'}: ${amount(limit*p.share/100,unit)}`).join(' · ')}`:'No windows · the whole daily budget is available all day.';
  for(const row of container.children)row.querySelector('[data-window-end]').hidden=row.querySelector('[name="windowMidnight"]').checked;
 };
 const add=(p={name:'Heating',start:1020,end:1320,share:100})=>{
  if(container.children.length>=12)return toast('Choose up to twelve heating windows.',true);
  const row=document.createElement('fieldset');row.className='gas-budget-period';
  row.innerHTML=`<legend>Heating window</legend>${input('Name','windowName',p.name,'maxlength="60" required')}<div class="form-grid">${clockInput('Starts','windowStart',clock(p.start))}<div data-window-end>${clockInput('Ends','windowEnd',clock(p.end===1440?1439:p.end))}</div>${input('Share of daily budget %','windowShare',p.share,'type="number" min="1" max="100" step="0.1" required')}</div><label class="check-label"><input type="checkbox" name="windowMidnight" ${p.end===1440?'checked':''}> Ends at midnight</label><button class="text-link" type="button" data-remove-window>Remove window</button>`;
  row.querySelector('[data-remove-window]').onclick=()=>{row.remove();update();};container.append(row);bindClockInputs(row);update();
 };
 data.settings.periods.forEach(add);update();form.querySelector('#add-gas-window').onclick=()=>add();
 form.addEventListener('input',update);form.addEventListener('change',update);
 form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{
   const values={enabled:form.elements.enabled.checked,unit:form.elements.unit.value,dailyLimit:Number(form.elements.dailyLimit.value),action:form.elements.action.value,staleMinutes:Number(form.elements.staleMinutes.value),periods:readPeriods()};
   await api('settings',{method:'POST',body:JSON.stringify({section:'gasBudget',values})});editor.close();await ctx.reload();toast('Gas budget saved.');
  }catch(error){form.querySelector('.form-error').textContent=error.message;button.disabled=false;}
 };
}
