import {bindHouseSetpoint} from '../heating-overview.js';
import {bindThermostat} from './thermostat-controls.js';
import {openHeatingAnalysis} from './heating-analysis.js';
import {api,esc,fixed,dialog,input,select,fields,toast,clockTime,clockInput,bindClockInputs} from '../ui.js';
const clock=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const asMinute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
// getRandomValues also works when the app is opened over plain HTTP on the LAN.
const periodId=()=>`period_${Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>n.toString(16).padStart(2,'0')).join('')}`;
const profileFor=(plan,slot)=>plan.activities.find(p=>p.id===slot.activityId);
const highCount=(plan,slot,rooms)=>rooms.filter(r=>profileFor(plan,slot)?.rooms[r.id]?.priority==='high').length;

export function planningControls(data){
 const occupancy=data.plan.occupancy,weather=data.smartPlan.weather;
 return `<div class="planning-toolbar"><button class="button ${data.control?.active?'':'secondary'}" id="edit-thermostat">Smart Thermostat · ${data.control?.active?'Active':'Planning'}</button><button class="button secondary" id="edit-schedule">Schedule</button><button class="button secondary" id="edit-household">Occupancy · ${occupancy.effective==='home'?'Home':'Away'}</button><button class="button secondary" id="edit-weather">Weather planning · ${weather.status==='current'?`${fixed(weather.outdoor.temperature)}°C outside`:weather.enabled?'Awaiting weather':'Off'}</button><button class="text-link" id="explain-modes">Help</button><button class="text-link" id="open-heating-analysis">Observations →</button></div>`;
}
export async function savePlan(ctx,plan){await api('settings',{method:'POST',body:JSON.stringify({section:'heatingPlan',values:plan})});}
export function bindPlanning(view,ctx){
 bindThermostat(ctx);
 bindHouseSetpoint(view,ctx,savePlan);
 document.querySelector('#edit-schedule').onclick=()=>editSchedule(view,ctx);
 document.querySelector('#edit-household').onclick=()=>editHousehold(view,ctx);
 document.querySelector('#edit-weather').onclick=()=>editWeather(view,ctx);
 document.querySelector('#explain-modes').onclick=()=>dialog(`<h2>Heating modes</h2><div class="mode-explanation"><h3>Local PID</h3><p>The ESP controls heating using the house average, with its local probe as fallback.</p><h3>Planning</h3><p>Shows planned room targets and boiler flow. Local PID keeps boiler control; radiator settings are unchanged.</p><h3>Active</h3><p>Coordinates boiler flow and smart radiator openings. Select Cold Harbour on the ESP too. Missing feedback returns boiler control to Local PID.</p><h3>Room priorities</h3><p>High uses the house setpoint; Low uses the low temperature. Each room’s warmer/cooler preferences apply to both. Schedules and occupancy choose the priority.</p></div>`);
}

const overridePeriods=plan=>[...new Map(['timeline','awayTimeline'].flatMap(key=>[1,6].flatMap(day=>plan[key][day].map(slot=>[slot.activityId,[slot.activityId,`${key==='timeline'?'Home':'Away'} · ${day===1?'Weekdays':'Weekends'} · ${clockTime(clock(slot.start))} · ${profileFor(plan,slot).name}`]])))).values()];
export function scheduleMarkup(plan,rooms,selected={days:[1,2,3,4,5],index:0},occupancy='home',entities=[]){
 const key=occupancy==='away'?'awayTimeline':'timeline';
 const row=(name,days)=>{
  const slots=plan[key][days[0]];
  return `<div class="routine-row"><div class="routine-row-heading"><h3>${name}</h3><button type="button" class="text-link" data-add-period="${days.join(',')}">Add period</button></div><div class="routine-ruler"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>12 am</span></div><div class="routine-track">${slots.map((slot,i)=>{const end=slots[i+1]?.start ?? 1440,count=highCount(plan,slot,rooms);return `<button type="button" class="routine-period ${i===0?'routine-period-first':''} ${i===slots.length-1?'routine-period-last':''}" data-period-index="${i}" data-period-days="${days.join(',')}" style="left:${slot.start/14.4}%;width:${(end-slot.start)/14.4}%;background:${count?'#527b64':'#7c8791'}" aria-label="Edit ${esc(name)}, ${esc(profileFor(plan,slot).name)}, ${clockTime(clock(slot.start))}, ${count} high-priority rooms"><span>${esc(profileFor(plan,slot).name)}</span><small>${clockTime(clock(slot.start))} · ${count} High</small></button>`;}).join('')}${slots.slice(1).map((slot,i)=>`<button type="button" class="routine-boundary" data-boundary-index="${i+1}" data-period-days="${days.join(',')}" style="left:${slot.start/14.4}%" role="slider" aria-label="${esc(name)} period start" aria-valuemin="${slots[i].start+1}" aria-valuemax="${(slots[i+2]?.start ?? 1440)-1}" aria-valuenow="${slot.start}" aria-valuetext="${clockTime(clock(slot.start))}"></button>`).join('')}<div class="routine-drag-tooltip" hidden></div></div></div>`;
 };
 const slots=plan[key][selected.days[0]],slot=slots[selected.index],profile=profileFor(plan,slot);
 return `<h2>Heating schedule</h2><div class="section-heading"><div class="segmented" aria-label="Schedule occupancy">${[['home','Someone home'],['away','Everyone away']].map(([id,label])=>`<button type="button" data-schedule-occupancy="${id}" class="${occupancy===id?'selected':''}" aria-pressed="${occupancy===id}">${label}</button>`).join('')}</div></div><p class="field-help">Editing the ${occupancy==='home'?'someone-home':'everyone-away'} schedule. Each has weekday and weekend plans. Occupancy selects which runs, after the away delay. Unknown tracking keeps the home schedule.</p><p class="field-help">Select a period and choose High or Low for each room. High uses this period’s setpoint, or the house setpoint when blank; Low uses the low temperature, capped at High. Drag a divider to change its time. Save schedule saves changes to both occupancy plans.</p>${row('Weekdays',[1,2,3,4,5])}${row('Weekends',[6,0])}<form id="period-form" class="schedule-period-editor"><h3>${selected.days.length===5?'Weekdays':'Weekends'} · ${clockTime(clock(slot.start))}</h3><div class="form-grid">${input('Period name','name',profile.name,'required maxlength="60"')}${clockInput('Starts at','start',clock(slot.start))}${input('Period setpoint °C (optional)','periodTarget',profile.houseTarget ?? '',`type="number" min="7" max="28" step="0.5" placeholder="House setpoint (${plan.houseTarget}°C)"`)}</div><p class="field-help">${selected.index===0?'The first period starts at midnight.':'This period continues until the next start time.'} Choose warmer, cooler or the same temperature in Edit room.</p><div class="schedule-room-list">${rooms.map(room=>`<div><span>${esc(room.name)}</span>${select(`${esc(room.name)} priority`,`priority_${esc(room.id)}`,[['high','High'],['low','Low']],profile.rooms[room.id]?.priority || 'low')}</div>`).join('')}</div>${selected.index>0?'<button type="button" class="button danger" id="remove-period">Remove period</button>':''}<fieldset><legend>Home Assistant schedule override</legend><div class="form-grid">${select('Binary sensor','overrideEntity',[['','No sensor override'],...entities.map(e=>[e.entity_id,e.attributes?.friendly_name || e.entity_id]),...(plan.scheduleOverride&&!entities.some(e=>e.entity_id===plan.scheduleOverride.entityId)?[[plan.scheduleOverride.entityId,plan.scheduleOverride.entityId]]:[])],plan.scheduleOverride?.entityId || '')}${select('Profile while sensor is on','overrideActivity',overridePeriods(plan),plan.scheduleOverride?.activityId || slot.activityId)}</div><p class="field-help">While the sensor is on, this profile overrides both occupancy schedules, every day. Off, unknown or unavailable resumes the normal schedule. Save schedule applies this setting too.</p></fieldset><div class="form-actions"><button class="button" type="submit">Save schedule</button></div><p class="form-error" role="alert"></p></form>`;
}

async function editSchedule(view,ctx){
 let entities=[];try{entities=(await api('entities')).entities.filter(e=>e.entity_id.startsWith('binary_sensor.'));}catch(error){toast(`Sensor list unavailable: ${error.message}`,true);}
 const plan=structuredClone(view.data.plan.settings),rooms=view.data.rooms;let occupancy=view.data.plan.occupancy.effective,key=occupancy==='away'?'awayTimeline':'timeline',selected={days:[1,2,3,4,5],index:0};
 const selections={home:{days:[1,2,3,4,5],index:0},away:{days:[1,2,3,4,5],index:0}};
 const editor=dialog('');
 const setSlots=(days,slots)=>{for(const day of days)plan[key][day]=structuredClone(slots);};
 const tidy=()=>{const ids=new Set([...plan.timeline,...plan.awayTimeline].flat().map(s=>s.activityId));if(plan.scheduleOverride)ids.add(plan.scheduleOverride.activityId);plan.activities=plan.activities.filter(p=>ids.has(p.id));};
 const render=()=>{
  document.querySelector('#dialog-content').innerHTML=scheduleMarkup(plan,rooms,selected,occupancy,entities);
  const root=document.querySelector('#dialog-content'),form=root.querySelector('#period-form');bindClockInputs(form);
  const currentSlots=()=>plan[key][selected.days[0]];
  if(selected.index===0)form.querySelectorAll('[data-clock-part]').forEach(el=>el.disabled=true);
  const updateProfile=()=>{
   const slots=structuredClone(currentSlots()),slot=slots[selected.index],previous=profileFor(plan,slot);
   const updated={...previous,id:periodId(),name:form.elements.name.value,targetMode:'house',offset:0,rooms:Object.fromEntries(rooms.map(r=>[r.id,{offset:0,priority:form.elements.namedItem(`priority_${r.id}`).value}]))};
   if(form.elements.periodTarget.value==='')delete updated.houseTarget;else updated.houseTarget=Number(form.elements.periodTarget.value);
   if(plan.scheduleOverride?.activityId===previous.id)plan.scheduleOverride.activityId=updated.id;
   const chosen=form.elements.overrideActivity.value===previous.id?updated.id:form.elements.overrideActivity.value;
   plan.activities.push(updated);slot.activityId=updated.id;setSlots(selected.days,slots);tidy();
   form.elements.overrideActivity.innerHTML=overridePeriods(plan).map(([id,label])=>`<option value="${esc(id)}" ${id===chosen?'selected':''}>${esc(label)}</option>`).join('');
   root.querySelectorAll('[data-period-index]').forEach(button=>{if(button.dataset.periodDays===selected.days.join(',')&&Number(button.dataset.periodIndex)===selected.index){const count=highCount(plan,slot,rooms);button.querySelector('span').textContent=updated.name;button.querySelector('small').textContent=`${clockTime(clock(slot.start))} · ${count} High`;button.style.background=count?'#527b64':'#7c8791';}});
  };
  form.elements.name.oninput=updateProfile;
  form.elements.periodTarget.onchange=updateProfile;
  const updateOverride=()=>{const entityId=form.elements.overrideEntity.value;if(entityId)plan.scheduleOverride={entityId,activityId:form.elements.overrideActivity.value};else plan.scheduleOverride=null;};
  form.elements.overrideEntity.onchange=updateOverride;form.elements.overrideActivity.onchange=updateOverride;
  form.querySelectorAll('[name^="priority_"]').forEach(el=>el.onchange=updateProfile);
  form.querySelector('[data-clock-input]').addEventListener('change',()=>{
   const slots=structuredClone(currentSlots()),index=selected.index,min=index===0?0:slots[index-1].start+1,max=index===0?0:(slots[index+1]?.start ?? 1440)-1;
   slots[index].start=Math.max(min,Math.min(max,asMinute(form.elements.start.value)));setSlots(selected.days,slots);render();
  });
  root.querySelectorAll('[data-period-index]').forEach(button=>button.onclick=()=>{selected={days:button.dataset.periodDays.split(',').map(Number),index:Number(button.dataset.periodIndex)};render();});
  root.querySelectorAll('[data-add-period]').forEach(button=>button.onclick=()=>{
   const days=button.dataset.addPeriod.split(',').map(Number),slots=structuredClone(plan[key][days[0]]);if(slots.length>=96)return toast('A day can have up to 96 periods.',true);
   let start=720;while(slots.some(s=>s.start===start))start++;const previous=[...slots].reverse().find(s=>s.start<start) || slots[0];slots.push({start,activityId:previous.activityId});slots.sort((a,b)=>a.start-b.start);setSlots(days,slots);selected={days,index:slots.findIndex(s=>s.start===start)};render();
  });
  root.querySelectorAll('[data-schedule-occupancy]').forEach(button=>button.onclick=()=>{selections[occupancy]=selected;occupancy=button.dataset.scheduleOccupancy;key=occupancy==='away'?'awayTimeline':'timeline';selected=selections[occupancy];render();});
  root.querySelector('#remove-period')?.addEventListener('click',()=>{const slots=structuredClone(currentSlots());const removed=slots.splice(selected.index,1)[0];setSlots(selected.days,slots);if(plan.scheduleOverride?.activityId===removed.activityId&&![...plan.timeline,...plan.awayTimeline].flat().some(s=>s.activityId===removed.activityId))plan.scheduleOverride=null;tidy();selected.index=Math.max(0,selected.index-1);render();});
  root.querySelectorAll('.routine-boundary').forEach(handle=>{
   const days=handle.dataset.periodDays.split(',').map(Number),index=Number(handle.dataset.boundaryIndex),slots=plan[key][days[0]],start=slots[index].start,min=slots[index-1].start+1,end=slots[index+1]?.start ?? 1440,max=end-1,track=handle.closest('.routine-track'),periods=track.querySelectorAll('.routine-period'),tooltip=track.querySelector('.routine-drag-tooltip');let minute=start;
   const display=value=>{minute=Math.max(min,Math.min(max,value));handle.style.left=`${minute/14.4}%`;handle.setAttribute('aria-valuenow',minute);handle.setAttribute('aria-valuetext',clockTime(clock(minute)));periods[index-1].style.width=`${(minute-slots[index-1].start)/14.4}%`;periods[index].style.left=`${minute/14.4}%`;periods[index].style.width=`${(end-minute)/14.4}%`;tooltip.hidden=false;tooltip.textContent=clockTime(clock(minute));tooltip.style.left=`${Math.max(30,Math.min(track.clientWidth-30,minute/1440*track.clientWidth))}px`;};
   const commit=()=>{const next=structuredClone(slots);next[index].start=minute;setSlots(days,next);render();};
   handle.onpointerdown=event=>{if(event.pointerType==='mouse'&&event.button!==0)return;event.preventDefault();handle.setPointerCapture(event.pointerId);display(minute);};
   handle.onpointermove=event=>{if(handle.hasPointerCapture(event.pointerId)){const rect=track.getBoundingClientRect();display(Math.round((event.clientX-rect.left)/rect.width*1440/5)*5);}};
   handle.onpointerup=event=>{if(handle.hasPointerCapture(event.pointerId)){handle.releasePointerCapture(event.pointerId);commit();}};
   handle.onpointercancel=()=>render();
   handle.onkeydown=event=>{const delta={ArrowLeft:-15,ArrowDown:-15,ArrowRight:15,ArrowUp:15}[event.key];if(delta===undefined&&!['Home','End'].includes(event.key))return;event.preventDefault();display(event.key==='Home'?min:event.key==='End'?max:minute+delta);commit();};
  });
  form.onsubmit=async event=>{event.preventDefault();try{tidy();plan.manualActivity='auto';await savePlan(ctx,plan);editor.close();await ctx.reload();toast('Schedule saved.');}catch(error){form.querySelector('.form-error').textContent=error.message;}};
 };
 render();
}

async function editHousehold(view,ctx){
 try{
  const {entities}=await api('entities'),plan=structuredClone(view.data.plan.settings),occupancy=view.data.plan.occupancy,options=entities.filter(e=>/^(person|device_tracker)\./.test(e.entity_id));
  for(const p of plan.people)if(!options.some(e=>e.entity_id===p.entityId))options.push({entity_id:p.entityId,attributes:{friendly_name:p.name || p.entityId}});
  const editor=dialog(`<h2>Household occupancy</h2><p>${occupancy.effective==='home'?'Using the Someone home schedule.':'Using the Everyone away schedule.'}${occupancy.held?` Away delay: ${occupancy.remainingMinutes} minutes remaining.`:''}</p><div class="household-people">${occupancy.people.map(p=>`<div><strong>${esc(p.name)}</strong><span>${esc(p.status)}</span></div>`).join('')}</div><form id="household-form">${select('Occupancy mode','occupancyMode',[['auto','Follow Home Assistant'],['home','Treat house as occupied'],['away','Treat house as empty']],plan.occupancyMode)}<fieldset class="sensor-picker"><legend>People / trackers</legend>${options.map(e=>`<label class="sensor-choice"><input type="checkbox" name="people" value="${esc(e.entity_id)}" ${plan.people.some(p=>p.entityId===e.entity_id)?'checked':''}><span>${esc(e.attributes?.friendly_name || e.entity_id)}</span></label>`).join('') || '<p>No person entities available.</p>'}</fieldset>${input('Wait before switching to away (minutes)','awayDelayMinutes',plan.awayDelayMinutes,'type="number" min="0" max="120" required')}${input('Low temperature °C','awayTarget',plan.awayTarget,'type="number" min="5" max="25" step="0.5" required')}<p class="field-help">Switches to the away schedule after everyone is away for the selected delay. Missing tracking keeps the home schedule.</p><div class="form-actions"><button class="button">Save occupancy</button></div><p class="form-error" role="alert"></p></form>`);
  const form=document.querySelector('#household-form');form.onsubmit=async event=>{event.preventDefault();try{plan.people=new FormData(form).getAll('people').map(entityId=>({entityId,name:options.find(e=>e.entity_id===entityId).attributes?.friendly_name || entityId}));plan.occupancyMode=form.elements.occupancyMode.value;plan.awayDelayMinutes=Number(form.elements.awayDelayMinutes.value);plan.awayTarget=Number(form.elements.awayTarget.value);await savePlan(ctx,plan);editor.close();await ctx.reload();toast('Occupancy saved.');}catch(error){form.querySelector('.form-error').textContent=error.message;}};
 }catch(error){toast(error.message,true);}
}

async function editWeather(view,ctx){
 try{
  const {entities}=await api('entities'),plan=structuredClone(view.data.plan.settings),weather=plan.weather,options=[['','Choose an outside temperature…'],...entities.filter(e=>e.entity_id.startsWith('weather.')||e.entity_id.startsWith('sensor.')&&['°C','°F'].includes(e.attributes?.unit_of_measurement)).map(e=>[e.entity_id,`${e.attributes?.friendly_name || e.entity_id} · ${e.entity_id}`])];
  if(weather.entityId&&!options.some(([id])=>id===weather.entityId))options.push([weather.entityId,`${weather.entityId} · unavailable`]);
  const editor=dialog(`<h2>Weather-aware heat planning</h2><form id="weather-form"><label class="check-label"><input type="checkbox" name="enabled" ${weather.enabled?'checked':''}> Use outside weather and forecasts in the plan</label>${select('Reported outside temperature (for learning)','entityId',options,weather.entityId)}${select('Forecast weather entity','forecastEntityId',[['','Use the reported source if it is a weather entity'],...entities.filter(e=>e.entity_id.startsWith('weather.')).map(e=>[e.entity_id,`${e.attributes?.friendly_name || e.entity_id} · ${e.entity_id}`]),...(weather.forecastEntityId&&!entities.some(e=>e.entity_id===weather.forecastEntityId)?[[weather.forecastEntityId,`${weather.forecastEntityId} · unavailable`]]:[])],weather.forecastEntityId || '')}<p class="field-help">Use an outside sensor for observations and a weather entity for forecasts.</p><div class="form-grid">${input('Cold design temperature outside °C','designOutdoor',weather.designOutdoor,'type="number" min="-30" max="0" step="0.5" required')}${input('Minimum planned flow °C','minFlow',weather.minFlow,'type="number" min="25" max="60" step="0.5" required')}${input('Maximum planned flow °C','maxFlow',weather.maxFlow,'type="number" min="30" max="75" step="0.5" required')}${input('Flow correction per 1°C room shortfall','deficitGain',weather.deficitGain,'type="number" min="0" max="15" step="0.5" required')}${input('Maximum indicative warm-up window (minutes)','maxPreheatMinutes',weather.maxPreheatMinutes ?? 180,'type="number" min="15" max="360" required')}${input('Weather reading freshness (minutes)','staleMinutes',weather.staleMinutes,'type="number" min="15" max="360" required')}</div><div id="weather-preview"></div><p class="field-help">Flow stays within the configured range and the ESP’s limits. Forecast preparation is advisory.</p><p class="field-help">Missing weather uses the minimum flow plus room correction.</p><div class="form-actions"><button class="button secondary">Save weather plan</button><button class="button" id="save-view-forecast">Save & view forecast</button></div><p class="form-error" role="alert"></p></form>`);
  const form=document.querySelector('#weather-form');
  const preview=()=>{const value=fields(form),min=Number(value.minFlow),max=Number(value.maxFlow),design=Number(value.designOutdoor),target=plan.houseTarget;form.querySelector('#weather-preview').innerHTML=`<h3>Starting flow at the house target</h3><div class="weather-curve">${[-5,0,5,10,15].map(outside=>`<div><span>${outside}°C outside</span><strong>${fixed(min+(max-min)*Math.max(0,Math.min(1,(target-outside)/(target-design))))}°C flow</strong></div>`).join('')}</div><p class="field-help">Before room correction; applies only when a room needs heat. Weather planning ${form.elements.enabled.checked?'enabled':'disabled: minimum flow is used instead'}.</p>`;};
  form.oninput=preview;preview();
  form.onsubmit=async event=>{event.preventDefault();try{const value=fields(form);plan.weather={...weather,enabled:form.elements.enabled.checked,entityId:value.entityId,forecastEntityId:value.forecastEntityId,...Object.fromEntries(['designOutdoor','minFlow','maxFlow','deficitGain','staleMinutes','maxPreheatMinutes'].map(key=>[key,Number(value[key])]))};await savePlan(ctx,plan);editor.close();await ctx.reload();toast('Weather plan saved.');if(event.submitter?.id==='save-view-forecast')await openHeatingAnalysis(ctx,{tab:'forecast'});}catch(error){form.querySelector('.form-error').textContent=error.message;}};
 }catch(error){toast(error.message,true);}
}
