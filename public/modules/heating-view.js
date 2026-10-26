import {roomCard} from '../room-card.js';
import {heatingOverview} from '../heating-overview.js';
import {openHeatingAnalysis} from './heating-analysis.js';
import {api,esc,fixed,icon,pill,empty,dateTime} from '../ui.js';

import {chartShell,bindChart,chartColours} from '../charts.js';

import {planningControls,bindPlanning} from './heating-controls.js';

import {bindRadiators} from '../radiators.js';


const colours=chartColours;

const phaseStyles=[{key:'space_heating',label:'Heating',colour:'#629a77'},{key:'domestic_hot_water',label:'Hot water',colour:'#dfad55'},{key:'settling_after_hot_water',label:'Settling',colour:'#a78cbd'},{key:'idle',label:'Idle',colour:'#9aa8b3'}];

const phaseNames={space_heating:'Space heating',domestic_hot_water:'Hot water',settling_after_hot_water:'Settling after hot water',idle:'Idle',unknown:'Unknown'};


export const heatingView={

 id:'heating',label:'Heating',icon:'heating',minutes:1440,roomChartState:{},boilerChartState:{},

 async render(ctx){

  const [data,boiler,history,insights]=await Promise.all([api('heating'),api('boiler'),api(`heating/history?minutes=${this.minutes}`),api('heating/insights')]);Object.assign(this,{data,history,insights});

  const smart=data.smartPlan,weather=smart.weather;

  return `${heatingOverview(data,boiler)}

  ${planningControls(data)}

  <section class="card heat-decision climate-flow"><div><span class="data-label">Planned boiler flow</span><strong>${smart.kind==='unavailable'?'—':fixed(smart.flowC)}<small>°C</small></strong><p>${smart.heat?'For the leading room request':'No planned heat request'}</p></div><div><h3>Weather & forecast</h3><p>${weather.status==='current'?`${fixed(weather.outdoor.temperature)}°C outside · starting flow ${fixed(weather.baseFlowC)}°C + room correction ${fixed(weather.correctionC)}°C, capped at ${fixed(data.plan.settings.weather.maxFlow)}°C.`:weather.enabled?esc(weather.fallback):'Weather planning off'}</p><button class="text-link" id="open-forecast-analysis">Forecast & preparation · ${data.outlook?.hourlyPoints || 0} hourly points / ${data.outlook?.dailyDays || 0} days →</button></div>${smart.missingRooms.length?`<p class="planning-notice">${smart.missingRooms.length} room(s) awaiting fresh readings.</p>`:''}</section>

  <div class="section-heading lower-heading"><div><h2>Rooms</h2><p>${data.rooms.filter(r=>r.fresh).length} of ${data.rooms.length} reporting</p></div><button class="button" id="add-room">${icon('plus')} Add room</button></div>

  <div class="room-grid climate-rooms">${data.rooms.length?data.rooms.map(room=>roomCard(room,smart,insights.rooms.find(r=>r.id===room.id))).join(''):empty('No rooms configured','Add a room and select its temperature sensors.')}</div>

  <section class="card full-chart-card heating-history"><div class="section-heading"><div><h2>Rooms, targets and boiler demand</h2><p class="field-help">${esc(history.resolution)}</p></div><div class="segmented" aria-label="Heating history duration">${[[60,'1 hour'],[360,'6 hours'],[1440,'24 hours'],[10080,'7 days']].map(([id,label])=>`<button data-heating-minutes="${id}" class="${this.minutes===id?'selected':''}">${label}</button>`).join('')}</div></div><label class="check-label"><input id="show-room-targets" type="checkbox" ${this.showRoomTargets?'checked':''}> Show each room’s target as a dashed line</label>${chartShell('heating-room-chart','Room temperatures and planned targets')}<h3 class="boiler-history-label">Boiler request and modulation</h3>${chartShell('heating-demand-chart','Boiler requested flow temperature and modulation')}</section>

`;

 },

 bind(ctx){

  bindPlanning(this,ctx);
  document.querySelector('#open-heating-analysis').onclick=()=>openHeatingAnalysis(ctx);
  document.querySelector('#open-forecast-analysis').onclick=()=>openHeatingAnalysis(ctx,{tab:'forecast'});

  bindRadiators(ctx);

  document.querySelector('#add-room').onclick=()=>this.editRoom(ctx);

  document.querySelectorAll('.edit-room').forEach(b=>b.onclick=()=>this.editRoom(ctx,this.data.rooms.find(r=>r.id===b.dataset.id)));

  const common={rows:this.history.points,start:this.history.start,end:this.history.end,timezone:ctx.config.general.timezone,unit:'°C',maxGapMs:150000,bands:this.history.phaseBands,bandStyles:phaseStyles,extraExport:[['activity','Schedule period'],['occupancy','Household occupancy'],['thermal_context','Boiler phase'],['outdoor_c','Outside °C'],['weather_status','Weather status'],['planned_reason','Smart Thermostat reason'],...this.history.rooms.map(r=>[`priority_${r.id}`,`${r.name} priority`])]};

  const targets=this.history.rooms.map((r,i)=>({key:`target_${r.id}`,label:`${r.name} target`,colour:colours[i%colours.length],dashed:true}));

  this.roomChartState.hidden=[...new Set([...(this.roomChartState.hidden || []).filter(key=>!key.startsWith('target_')),...(this.showRoomTargets?[]:targets.map(s=>s.key))])];

  let rooms,demand;

  rooms=bindChart(document.querySelector('#heating-room-chart'),{...common,state:this.roomChartState,series:[...this.history.rooms.map((r,i)=>({key:`room_${r.id}`,label:r.name,colour:colours[i%colours.length]})),{key:'house_target_c',label:'House target',colour:'#344b59',dashed:true},...targets],extraTooltip:row=>[['Schedule period',row.activity],['Schedule base target',`${fixed(row.active_target_c)} °C`],['Household',row.occupancy],['Boiler flow request',`${fixed(row.requested_flow_c)} °C`],['Boiler modulation',`${fixed(row.modulation_pct)} %`],['Outside',`${fixed(row.outdoor_c)} °C`],['Smart plan',row.planned_reason]],onRangeChange:(range,zoomed)=>demand?.setView(range,zoomed)});

  demand=bindChart(document.querySelector('#heating-demand-chart'),{...common,state:this.boilerChartState,series:[{key:'planned_flow_c',label:'Smart Thermostat plan',colour:chartColours[1],unit:'°C',dashed:true},{key:'requested_flow_c',label:'Actual requested flow',colour:chartColours[0],unit:'°C'},{key:'modulation_pct',label:'Actual modulation',colour:chartColours[2],unit:'%',axis:'right'},{key:'pid_output_pct',label:'Local PID demand',colour:chartColours[3],unit:'%',axis:'right',dashed:true},...this.history.rooms.filter(r=>this.data.rooms.some(room=>room.id===r.id&&room.radiator)).map((r,i)=>({key:`valve_${r.id}`,label:`${r.name} planned opening`,colour:colours[(i+4)%colours.length],unit:'%',axis:'right',dashed:true}))],extraTooltip:row=>[['Schedule period',row.activity],['Boiler phase',phaseNames[row.thermal_context] || 'Unknown'],['Outside',`${fixed(row.outdoor_c)} °C`],['Smart plan',row.planned_reason]],onRangeChange:(range,zoomed)=>rooms?.setView(range,zoomed)});

  document.querySelector('#show-room-targets').onchange=event=>{this.showRoomTargets=event.target.checked;ctx.reload();};

  document.querySelectorAll('[data-heating-minutes]').forEach(button=>button.onclick=()=>{this.minutes=Number(button.dataset.heatingMinutes);this.roomChartState={};this.boilerChartState={};ctx.reload();});

 },

};

