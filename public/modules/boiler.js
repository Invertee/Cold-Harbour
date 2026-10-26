import {api,esc,icon} from '../ui.js';
import {chartShell,bindChart,chartColours} from '../charts.js';
import {boilerOverview,boilerEventTable,openBoilerDiagnostics,boilerPhases} from '../boiler-monitor.js';
const flag=value=>value===true?'On':value===false?'Off':'Unknown';
const temperatureSeries=[{key:'flow_c',label:'Primary water',colour:chartColours[0]},{key:'return_c',label:'Return water',colour:chartColours[1]},{key:'dhw_temperature_c',label:'Hot-water outlet',colour:chartColours[2]},{key:'requested_flow_c',label:'CH request',colour:chartColours[3]}];
const phaseStyles=[{key:'space_heating',label:'Heating',colour:'#629a77'},{key:'domestic_hot_water',label:'Hot water',colour:'#dfad55'},{key:'settling_after_hot_water',label:'Settling',colour:'#a78cbd'},{key:'idle',label:'Idle',colour:'#9aa8b3'}];
export const boiler={
 id:'boiler',label:'Boiler monitor',icon:'heating',minutes:60,chartSource:'telemetry',chartState:{},deltaState:{},showDelta:false,
 async render(ctx){
  const [data,chart,logs]=await Promise.all([api('boiler/diagnostics'),api(`boiler/chart?minutes=${this.minutes}&source=${this.chartSource}`),api('boiler/logs?kind=events&limit=12')]);
  this.chartData=chart;
  const latest=(chart.heatingPoints || chart.points).at(-1),liveDelta=data.status.connected&&latest?.at===data.status.lastSeen?latest.heating_delta_c:null;
  return `<div class="boiler-monitor-page">${boilerOverview(data,liveDelta)}
   <section class="card boiler-history-card"><div class="section-heading"><div><h2>Temperature history</h2><p>${esc(chart.resolution)}${chart.truncated?' · storage limit reached':''}</p></div><div class="segmented" aria-label="History duration">${[[15,'15 min'],[60,'1 hour'],[360,'6 hours'],[1440,'24 hours'],[10080,'7 days']].map(([minutes,label])=>`<button data-history-minutes="${minutes}" class="${this.minutes===minutes?'selected':''}">${label}</button>`).join('')}</div></div>
    ${chartShell('boiler-temperature-chart','Boiler temperatures over time')}
    <details class="boiler-chart-options" ${this.chartSource==='opentherm'?'open':''}><summary>Chart options & downloads</summary><label class="chart-source-select">Source<select id="boiler-chart-source"><option value="telemetry" ${this.chartSource==='telemetry'?'selected':''}>Device readings</option><option value="opentherm" ${this.chartSource==='opentherm'?'selected':''}>Captured OpenTherm measurements</option></select></label><a class="text-link" href="api/boiler/history?hours=168" download="cold-harbour-history.json">Download 7 days of history →</a></details>
    <details class="boiler-delta-section" id="boiler-delta-section" ${this.showDelta?'open':''}><summary>Heating delta-T <span>Flow minus return, during central heating</span></summary>${chartShell('boiler-delta-chart','Heating flow minus return temperature over time')}<p class="field-help">Central-heating samples only · dashed line: 20°C reference.</p></details>
   </section>
   <section class="card boiler-events-card"><div class="section-heading"><div><h2>Recent events</h2><p>Operating changes, faults and connections</p></div><button class="button secondary" id="view-boiler-events">View event history ${icon('arrow')}</button></div>${boilerEventTable(logs.rows,ctx.config.general.timezone)}</section>
  </div>`;
 },
 bind(ctx){
  const common={start:this.chartData.start,end:this.chartData.end,timezone:ctx.config.general.timezone,unit:'°C',maxGapMs:90000,bands:this.chartData.phaseBands,bandStyles:phaseStyles};
  const phaseTooltip=row=>[['Boiler phase',boilerPhases[row.thermal_context] || 'Unknown'],['Flame / CH / DHW',`${flag(row.flame)} / ${flag(row.ch_active)} / ${flag(row.dhw_active)}`],['Modulation',Number.isFinite(row.modulation_pct)?`${row.modulation_pct.toFixed(1)} %`:'Not reported']];
  bindChart(document.querySelector('#boiler-temperature-chart'),{...common,rows:this.chartData.points,series:temperatureSeries,state:this.chartState,extraTooltip:row=>this.chartSource==='opentherm'?[['Source','Captured message'],['Data ID',String(row.raw_id ?? '')],['Raw data',row.raw_data || '']]:[...phaseTooltip(row),['Heating delta-T',Number.isFinite(row.heating_delta_c)?`${row.heating_delta_c.toFixed(1)} °C`:'Not a heating sample']],extraExport:[['thermal_context','Boiler phase'],['flame','Flame'],['ch_active','CH active'],['dhw_active','DHW active'],['heating_delta_c','Heating delta-T (°C)']]});
  let deltaBound=false;
  const bindDelta=()=>{if(deltaBound)return;deltaBound=true;bindChart(document.querySelector('#boiler-delta-chart'),{...common,rows:this.chartData.heatingPoints || this.chartData.points,series:[{key:'heating_delta_c',label:'Heating delta-T',colour:'#9b6740'}],state:this.deltaState,references:[{value:20,label:'20°C reference'}],extraTooltip:phaseTooltip,extraExport:[['thermal_context','Boiler phase'],['ch_flow_c','Heating flow (°C)'],['ch_return_c','Heating return (°C)']]});};
  const delta=document.querySelector('#boiler-delta-section');delta.ontoggle=()=>{this.showDelta=delta.open;if(delta.open)bindDelta();};if(delta.open)bindDelta();
  document.querySelectorAll('[data-history-minutes]').forEach(button=>button.onclick=()=>{this.minutes=Number(button.dataset.historyMinutes);this.chartState={};this.deltaState={};ctx.reload();});
  document.querySelector('#boiler-chart-source').onchange=event=>{this.chartSource=event.target.value;this.chartState={};ctx.reload();};
  document.querySelector('#open-boiler-diagnostics').onclick=()=>openBoilerDiagnostics(ctx);
  document.querySelector('#view-boiler-events').onclick=()=>openBoilerDiagnostics(ctx,{tab:'events'});
 },
};
