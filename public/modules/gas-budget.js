import {api,toast,esc,fixed,money,relative,dateTime,input,select,clockTime} from '../ui.js';
import {openHeatingDialog} from './heating-dialog.js';
import {chartShell,bindChart,chartColours} from '../charts.js';

const amount=(value,unit)=>unit==='cost'?money(value):`${fixed(value,1)} kWh`;
const clock=minute=>minute===1440?'24:00':`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const periodTime=minute=>minute===1440?'midnight':clockTime(clock(minute));

export function gasBudgetMarkup(data,active){
 if(!data)return '';
 const {settings:s}=data,at=s.unit==='cost'?data.costAt:data.usageAt;
 const state=!s.enabled?'Budget off':data.emergencyOverride?(active?'Emergency heating':'Emergency heat planned'):data.paused?(active?'Pause requested':'Pause planned'):s.action==='monitor'?'Monitoring only':data.fresh?'Budget control on':'Awaiting gas data';
 const pauseControls=s.enabled?`<div class="form-actions compact"><button class="button secondary" id="toggle-budget-pause" data-paused="${!data.manualPause}">${data.manualPause?'Resume heating':'Pause heating today'}</button><a class="text-link" href="#settings/notifications">Gas budget phone warnings →</a></div>${data.manualPause&&s.action==='pause'&&data.wouldPause?'<p class="field-help">Resuming clears your manual pause; the automatic budget limit still applies.</p>':''}`:'';
 return `<section class="card gas-budget-card"><div class="section-heading"><div><h2>Gas today & heating budget</h2><p class="field-help">${esc(data.day)} · ${esc(state)}</p></div><button class="button secondary" id="edit-gas-budget">Heating plan & budget</button></div><div class="gas-budget-metrics"><div><span>Gas reported today</span><strong>${fixed(data.kwh,2)} kWh</strong><small>${data.usageFresh?'Fresh source':'No fresh reading'} · ${relative(data.usageAt)}</small></div><div><span>Reported gas cost</span><strong>${money(data.cost)}</strong><small>${data.costFresh?'Fresh source':'No fresh reading'} · ${relative(data.costAt)}</small></div><div><span>Daily budget</span><strong>${s.enabled?amount(s.dailyLimit,s.unit):'Not enabled'}</strong><small>${s.enabled?`${amount(data.remaining,s.unit)} remaining`:'Monitoring starts as daily readings arrive'}</small></div></div>${s.enabled?`<progress class="gas-budget-progress" max="1" value="${data.fraction ?? 0}" aria-label="Daily gas budget used"></progress><p role="status">${esc(data.reason)}</p>${data.allowance.scheduled?`<div class="gas-budget-windows">${data.allowance.periods.map(p=>`<div class="${p===data.allowance.current||p.start===data.allowance.current?.start?'current':''}"><strong>${esc(p.name)}</strong><span>${periodTime(p.start)}–${periodTime(p.end)}</span><span>${p.share}% · ${amount(s.dailyLimit*p.share/100,s.unit)}</span></div>`).join('')}</div><p class="field-help">${amount(data.allowance.limit,s.unit)} available so far, including carryover.</p>`:''}`:''}<p class="field-help">Latest ${s.unit==='cost'?'cost':'usage'} report: ${at?esc(dateTime(at,data.timezone,{day:'numeric',month:'short',second:'2-digit'})):'not available'}. Delayed meter readings can overshoot the budget.</p>${pauseControls}${chartShell('gas-day-chart','Reported gas use and cost throughout today')}<p class="field-help">Active mode pauses preserve local fallback and frost protection.</p></section>`;
}

export function bindGasBudget(ctx,data,state={}){
 if(!data)return;
 const maxCost=Math.max(1,...data.points.map(p=>p.cost).filter(Number.isFinite))*1.1;
 bindChart(document.querySelector('#gas-day-chart'),{rows:data.points,start:data.start,end:data.end,timezone:data.timezone,unit:'kWh',maxGapMs:150000,state,
  rightUnit:'GBP',rightDomain:[0,maxCost],series:[{key:'kwh',label:'Gas today',colour:chartColours[2],digits:2},{key:'cost',label:'Reported daily cost',colour:chartColours[0],axis:'right',unit:'GBP',digits:2}],
  references:data.settings.enabled&&data.settings.unit==='kwh'?[{value:data.settings.dailyLimit,label:'Daily gas budget',colour:'#a45b38'}]:[],
  extraTooltip:row=>[['Gas source report',dateTime(row.usage_at,data.timezone)],['Cost source report',dateTime(row.cost_at,data.timezone)]],extraExport:[['usage_at','Usage source timestamp'],['cost_at','Cost source timestamp']]});
 document.querySelector('#edit-gas-budget').onclick=()=>openHeatingDialog(ctx,{tab:'plan',focus:'gas-budget-settings'});
 const pause=document.querySelector('#toggle-budget-pause');
 if(pause)pause.onclick=async()=>{
  pause.disabled=true;
  try{await api('energy/gas-budget/pause',{method:'POST',body:JSON.stringify({paused:pause.dataset.paused==='true'})});await ctx.reload();}
  catch(error){toast(error.message,true);pause.disabled=false;}
 };
}

export function gasBudgetEditor(settings){
 return `<fieldset id="gas-budget-settings" class="heating-gas-settings"><legend>Daily gas budget</legend><p class="field-help">Choose phones and a warning threshold in Settings → Notifications.</p><label class="check-label"><input type="checkbox" name="budgetEnabled" ${settings.enabled?'checked':''}> Enable gas budget</label><div class="form-grid">${select('Budget measured in','budgetUnit',[['kwh','Gas energy · kWh'],['cost','Reported gas cost · £']],settings.unit)}${input('Daily limit','budgetDailyLimit',settings.dailyLimit,'type="number" min="0.01" max="10000" step="0.01" required')}${select('When the available allowance is used','budgetAction',[['monitor','Show status only'],['pause','Pause heating in Active mode']],settings.action)}${input('Accept gas readings up to this age (minutes)','budgetStaleMinutes',settings.staleMinutes,'type="number" min="5" max="360" required')}${input('Emergency room temperature °C','budgetEmergencyTempC',settings.emergencyTempC ?? 7,'type="number" min="7" max="25" step="0.5" required')}</div><p class="field-help">A cold room can heat to 0.5°C above the emergency temperature during an automatic or manual budget pause.</p><p class="field-help">Shares must total 100%, or all be 0% to make the full budget available all day.</p><p class="field-help">The daily limit includes hot water and resets at midnight.</p></fieldset>`;
}
