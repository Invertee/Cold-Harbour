import {input,select,fixed} from './ui.js';
import {roomControl,roomThresholds,requestedOpening} from './heating-model.js';
import {roomTargetPreview} from './room-targets.js';

export function roomControlFields(room){
 const c=roomControl(room);
 return `<details class="room-response"><summary>Heating response & valve opening</summary><p class="field-help">Stop a little before the target to let the radiator’s stored heat finish warming the room. Reopen at a larger shortfall to prevent rapid cycling.</p><div class="form-grid">${input('Reopen when below target by °C','heat_startBelow',c.startBelow,'type="number" min="0.05" max="3" step="0.05" required')}${input('Stop before target by °C','heat_stopBelow',c.stopBelow,'type="number" min="0" max="1.5" step="0.05" required')}</div>${select('Valve response while heat is needed','heat_openingMode',[['proportional','Gradual · proportional to shortfall'],['fixed','Fixed opening while heating']],c.openingMode)}<div class="form-grid">${input('Reach maximum opening at shortfall °C','heat_fullOpenBelow',c.fullOpenBelow,'type="number" min="0.1" max="6" step="0.1" required')}${input('Minimum opening %','heat_minOpening',c.minOpening,'type="number" min="5" max="100" step="5" required')}${input('Maximum opening %','heat_maxOpening',c.maxOpening,'type="number" min="5" max="100" step="5" required')}${input('Fixed opening %','heat_fixedOpening',c.fixedOpening,'type="number" min="5" max="100" step="5" required')}</div><div data-room-response-preview aria-live="polite"></div><p class="field-help">Opening settings apply to a mapped, supported TRV in Active mode. A satisfied room still closes. These percentages request valve travel; they do not measure heat output. Frost protection remains in effect.</p></details>`;
}
export function roomControlValues(form){
 return Object.fromEntries(Object.keys(roomControl({})).map(key=>[key,key==='openingMode'?form.elements[`heat_${key}`].value:Number(form.elements[`heat_${key}`].value)]));
}
export function roomResponsePreview(room){
 const c=roomControl(room),t=roomThresholds(room);
 if(c.startBelow<=c.stopBelow||c.fullOpenBelow<=c.stopBelow||c.minOpening>c.maxOpening)return '<p class="field-help">Reopen and maximum-opening shortfalls must exceed the stop setting. Minimum opening must not exceed maximum.</p>';
 const opening=requestedOpening({...room,fresh:true,callingForHeat:true,deficit:c.startBelow+0.001});
 const points=[...new Set([3,2,1,0.5,c.startBelow,c.stopBelow,0])].sort((a,b)=>b-a);
 return `<p class="field-help">At a ${fixed(room.target,2)}°C target: opens below <strong>${fixed(t.opensBelowC,2)}°C</strong>, initially about <strong>${opening}%</strong>. Closes at <strong>${fixed(t.closesAtC,2)}°C</strong>.${Number.isFinite(room.current)?` Current room: ${fixed(room.current,2)}°C.`:''}</p><div class="table-scroll"><table><thead><tr><th>Room temperature</th><th>Opening while warming</th></tr></thead><tbody>${points.map(deficit=>`<tr><td>${fixed(room.target-deficit,2)}°C</td><td>${requestedOpening({...room,fresh:true,deficit,callingForHeat:deficit>c.stopBelow})}%</td></tr>`).join('')}</tbody></table></div><p class="field-help">The warming column shows an already open valve tapering until the close temperature. A closed valve waits for the reopen temperature.</p>`;
}
export function bindRoomControl(form,room,settings){
 const update=()=>{
  const control=roomControlValues(form),targets=roomTargetPreview(settings,Number(form.elements.targetOffset.value),Number(form.elements.awayOffset.value));
  const target=room.priority==='low'?targets.low:targets.high;
  form.querySelector('[data-room-response-preview]').innerHTML=roomResponsePreview({...room,target,heatControl:control});
  form.elements.heat_fixedOpening.disabled=control.openingMode!=='fixed';
  form.elements.heat_fullOpenBelow.disabled=control.openingMode==='fixed';
 };
 form.addEventListener('input',update);form.addEventListener('change',update);update();
}
