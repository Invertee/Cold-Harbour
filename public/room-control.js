import {input,select,fixed} from './ui.js';
import {roomControl,roomThresholds,requestedOpening} from './heating-model.js';
import {roomTargetPreview} from './room-targets.js';

export function roomControlFields(room){
 const c=roomControl(room);
 return `<details class="room-response"><summary>Heating response & valve opening</summary>
  <div class="form-grid">
   ${input('Reopen below target by °C','heat_startBelow',c.startBelow,'type="number" min="0.05" max="3" step="0.05" required')}
   ${input('Stop before target by °C','heat_stopBelow',c.stopBelow,'type="number" min="0" max="1.5" step="0.05" required')}
  </div>
  ${select('Opening while heating','heat_openingMode',[['proportional','Proportional'],['fixed','Fixed']],c.openingMode)}
  <div class="form-grid">
   ${input('Shortfall for maximum opening °C','heat_fullOpenBelow',c.fullOpenBelow,'type="number" min="0.1" max="6" step="0.1" required')}
   ${input('Fixed opening %','heat_fixedOpening',c.fixedOpening,'type="number" min="5" max="100" step="5" required')}
   ${input('Minimum opening %','heat_minOpening',c.minOpening,'type="number" min="5" max="100" step="5" required')}
   ${input('Maximum opening %','heat_maxOpening',c.maxOpening,'type="number" min="5" max="100" step="5" required')}
  </div>
  <p class="field-help" data-room-response-preview aria-live="polite"></p>
 </details>`;
}
export function roomControlValues(form){
 return Object.fromEntries(Object.keys(roomControl({})).map(key=>[key,key==='openingMode'?form.elements[`heat_${key}`].value:Number(form.elements[`heat_${key}`].value)]));
}
export function roomResponsePreview(room){
 room={...room,heatingTarget:room.target,controlDeficit:undefined};
 const c=roomControl(room),t=roomThresholds(room);
 if(c.startBelow<=c.stopBelow)return 'Set the reopen shortfall above the stop setting.';
 if(c.openingMode==='proportional'&&c.fullOpenBelow<=c.stopBelow)return 'Set the maximum-opening shortfall above the stop setting.';
 if(c.minOpening>c.maxOpening)return 'Set minimum opening at or below maximum opening.';
 if(c.openingMode==='fixed'&&(c.fixedOpening<c.minOpening||c.fixedOpening>c.maxOpening))return 'Set fixed opening within the minimum and maximum.';
 const opening=requestedOpening({...room,fresh:true,callingForHeat:true,deficit:c.startBelow+0.001});
 return `Before sun correction · Opens at ${opening}% below ${fixed(t.opensBelowC,2)}°C · Closes at ${fixed(t.closesAtC,2)}°C`;
}
export function bindRoomControl(form,room,settings){
 const update=()=>{
  const control=roomControlValues(form),targets=roomTargetPreview(settings,Number(form.elements.targetOffset.value),Number(form.elements.awayOffset.value));
  const target=room.priority==='low'?targets.low:targets.high;
  form.querySelector('[data-room-response-preview]').textContent=roomResponsePreview({...room,target,heatControl:control,budgetPaused:false});
  for(const [field,hidden] of [['heat_fixedOpening',control.openingMode!=='fixed'],['heat_fullOpenBelow',control.openingMode==='fixed']]){
   form.elements[field].disabled=hidden;
   form.elements[field].closest('label').hidden=hidden;
  }
 };
 form.addEventListener('input',update);form.addEventListener('change',update);update();
}
