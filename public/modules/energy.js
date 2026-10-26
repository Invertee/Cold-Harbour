import { api,esc,fixed,money,relative,time,empty } from '../ui.js';
import {chartShell,bindChart,chartColours,normalisePoints} from '../charts.js';

// Accumulate before zooming so totals always start at the selected period.
// A missing charge makes subsequent cost totals unknown, rather than zero.
export function cumulativeEnergyRows(rows) {
  let energy=0,cost=0;
  return normalisePoints(rows).map(row=>{
    energy=energy!==null&&Number.isFinite(row.kwh)?energy+row.kwh:null;
    cost=cost!==null&&Number.isFinite(row.cost)?cost+row.cost:null;
    return {...row,cumulativeKwh:energy,cumulativeCost:cost};
  });
}

function coverage(data,kind) {
  if(!data.coverage)return '';
  const {expectedDays}=data.coverage,count=data.coverage[kind==='usage'?'usageDays':'costDays'];
  if(data.coverage[kind==='usage'?'partialUsageDays':'partialCostDays'])return '<div class="metric-caption">Includes partial days</div>';
  if(expectedDays>1 && count<expectedDays)return `<div class="metric-caption">${count} of ${expectedDays} days available</div>`;
  return data.cached?'<div class="metric-caption">Cached · source unavailable</div>':'';
}
function tariff(fuel,data,timezone) {
  const next=data.nextRate;
  return `<div class="tariff-row"><span>${fuel==='gas'?'Gas':'Electricity'}</span><span>${data.unitRate===null?'Rate unavailable':`${fixed(data.unitRate,2)}p/kWh`}${data.standingCharge===null?'':` · ${fixed(data.standingCharge,2)}p/day`}</span>${next?`<span class="muted">Next: ${fixed(next.value,2)}p at ${time(next.start,timezone)}</span>`:''}${data.tariff?`<span class="tariff-code">${esc(data.tariff)}</span>`:''}${data.rateAdjusted?'<span class="small-tag">Intelligent adjusted rate</span>':''}</div>`;
}
export const energy = {
  id:'energy',label:'Energy',icon:'energy',period:'today',fuel:'electricity',chartView:'interval',chartState:{},powerState:{},
  async render(ctx) {
    const data=await api(`energy?period=${this.period}`),config=ctx.config,live=data.live;
    const power=live?.fresh?live.watts:null;
    const unit=power!==null&&power<0?'Export now':'Power now';
    const periodLabel=this.period==='today'?'today':this.period==='yesterday'?'yesterday':'this week';
    const costHour=power===null||data.unitRate===null?null:Math.max(0,power)/1000*data.unitRate/100;
    const source='BottlecapDave · Home Assistant';
    const errors=[data.ha.error&&`Home Assistant: ${data.ha.error}`,...(data.integration?.warnings || [])].filter(Boolean);
    const selected={...data[this.fuel],rows:cumulativeEnergyRows(data[this.fuel].rows),period:this.period,range:data.range,fuel:this.fuel};this.chartData=selected;this.powerSamples=data.samples;
    return `${errors.length?`<div class="data-errors" role="status">${errors.map(message=>`<p>${esc(message)} <a class="text-link" href="#settings/connections">Check connection</a></p>`).join('')}</div>`:''}
    <div class="energy-toolbar"><span class="muted">${esc(source)}</span><div class="energy-toolbar-controls"><div class="segmented" aria-label="Energy fuel">${[['electricity','Electricity'],['gas','Gas']].map(([id,label])=>`<button data-fuel="${id}" class="${this.fuel===id?'selected':''}" aria-pressed="${this.fuel===id}">${label}</button>`).join('')}</div><div class="segmented" aria-label="Energy period">${[['today','Today'],['yesterday','Yesterday'],['week','7 days']].map(([id,label])=>`<button data-period="${id}" class="${this.period===id?'selected':''}" aria-pressed="${this.period===id}">${label}</button>`).join('')}</div></div></div>
    <div class="energy-top"><section class="power-card" aria-label="${unit}"><div class="power-card-top"><span class="data-label">${unit}</span><span class="live-label"><span class="status-dot"></span>${live?.fresh?'Live':'No fresh data'}</span></div><div class="power-number">${fixed(power===null?null:Math.abs(power),0)}<span>W</span></div><div class="power-caption">${live?.fresh?`${esc(live.source)} · ${relative(live.at)}`:'Connect a power sensor through Home Assistant.'}</div>${chartShell('power-chart','Power history',{compact:true})}<div class="power-card-footer"><span>${money(costHour)}<small> / hour, estimated</small></span></div></section>
    <div class="energy-stats dual-fuel-stats">${['electricity','gas'].map(fuel=>{const value=data[fuel],label=fuel==='gas'?'Gas':'Electricity';return `<section class="card metric-card"><div class="metric-top">${label} ${periodLabel}</div><div class="metric-number">${fixed(value.kwh,2)} <span>kWh</span></div>${coverage(value,'usage')}</section>`;}).join('')}${['electricity','gas'].map(fuel=>{const value=data[fuel],label=fuel==='gas'?'Gas':'Electricity';return `<section class="card metric-card"><div class="metric-top">${label} ${value.estimated?'estimated ':''}cost</div><div class="metric-number">${money(value.cost)}</div>${coverage(value,'cost')}${value.cost!==null&&!value.estimated?'<div class="metric-caption">From Home Assistant</div>':''}</section>`;}).join('')}</div></div>
    <section class="card consumption-card"><div class="section-heading"><div class="chart-label"><h2>${this.fuel==='gas'?'Gas':'Electricity'} use</h2><span class="muted">${this.chartView==='interval'?'kWh per interval':this.chartView==='energy'?'Running total · kWh':'Running total · GBP · excludes standing charges'}</span></div><div class="segmented energy-chart-views" aria-label="Energy chart view">${[['interval','Per interval'],['energy','Cumulative energy'],['cost','Cumulative cost']].map(([id,label])=>`<button data-chart-view="${id}" class="${this.chartView===id?'selected':''}" aria-pressed="${this.chartView===id}">${label}</button>`).join('')}</div></div>${chartShell('energy-interval-chart',`${this.fuel} ${this.chartView==='interval'?'consumption':`cumulative ${this.chartView}`}`)}<div class="chart-footer"><span><span class="legend-dot"></span>${this.fuel==='gas'?'Gas consumption':'Grid import'} · totals from available intervals${this.chartView==='cost'?' · missing charges are not estimated':''}</span><span>${selected.rows.length?`Last interval: ${time(selected.rows.at(-1).start,config.general.timezone)}–${time(selected.rows.at(-1).end,config.general.timezone)}`:'No interval history'}${selected.cached?' · cached':''}</span></div></section>
    <div class="card tariff-details" aria-label="Current tariffs">${tariff('electricity',data.electricity,config.general.timezone)}${tariff('gas',data.gas,config.general.timezone)}</div>`;
  },
  bind(ctx) {
    const range=this.chartData.range;
    const cumulative=this.chartView!=='interval',cost=this.chartView==='cost';
    bindChart(document.querySelector('#energy-interval-chart'),{rows:this.chartData.rows.map(row=>cumulative?{...row,at:row.end}:row),series:[{key:cumulative?(cost?'cumulativeCost':'cumulativeKwh'):'kwh',label:cumulative?(cost?'Cumulative cost':'Cumulative energy'):(this.fuel==='gas'?'Gas':'Electricity'),colour:chartColours[cost?1:0],digits:cost?2:3}],kind:cumulative?'line':'bar',unit:cost?'GBP':'kWh',maxGapMs:3600000,start:new Date(range.start).toISOString(),end:new Date(this.period==='today'?range.dayEnd:range.end).toISOString(),timezone:ctx.config.general.timezone,state:this.chartState,extraTooltip:row=>[['Interval energy',`${fixed(row.kwh,3)} kWh`],['Interval cost',row.cost===null||row.cost===undefined?'Not reported':money(row.cost)],['Energy so far',row.cumulativeKwh===null?'Incomplete readings':`${fixed(row.cumulativeKwh,3)} kWh`],['Cost so far (excl. standing charges)',row.cumulativeCost===null?'Incomplete charges':money(row.cumulativeCost)],['Data source','Home Assistant · actual meter interval']],extraExport:[['start','Interval starts'],['end','Interval ends'],['kwh','Interval energy (kWh)'],['cost','Reported cost (GBP)'],['cumulativeKwh','Cumulative energy (kWh)'],['cumulativeCost','Cumulative cost excluding standing charges (GBP)']]});
    bindChart(document.querySelector('#power-chart'),{rows:this.powerSamples,series:[{key:'watts',label:'Power',colour:'#d6e5aa',digits:0}],unit:'W',compact:true,timezone:ctx.config.general.timezone,maxGapMs:180000,state:this.powerState});
    document.querySelectorAll('[data-period]').forEach(button=>button.addEventListener('click',()=>{this.period=button.dataset.period;this.chartState={};ctx.reload();}));
    document.querySelectorAll('[data-fuel]').forEach(button=>button.addEventListener('click',()=>{this.fuel=button.dataset.fuel;this.chartState={};ctx.reload();}));
    document.querySelectorAll('[data-chart-view]').forEach(button=>button.addEventListener('click',()=>{this.chartView=button.dataset.chartView;this.chartState={};ctx.reload();}));
  },
};
