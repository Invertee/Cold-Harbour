import {esc,fixed} from './ui.js';
import {sunTargetReduction} from './heating-model.js';
import {roomTargetPreview} from './room-targets.js';

export function roomSunFields(room){
 const value=room.sunExposure ?? 0;
 return `<section class="room-sun">
  <div class="room-sun-heading"><label for="room-sun-impact">Sun impact</label><output for="room-sun-impact" data-sun-label>${value}%</output></div>
  <input id="room-sun-impact" name="sunExposure" type="range" min="0" max="100" step="5" value="${esc(value)}" aria-describedby="room-sun-help">
  <p id="room-sun-help" class="field-help" data-sun-preview></p>
 </section>`;
}

export function bindRoomSun(form,room,settings){
 const slider=form.elements.sunExposure,output=form.querySelector('[data-sun-label]'),preview=form.querySelector('[data-sun-preview]');
 const update=()=>{
  const value=Number(slider.value);
  const targets=roomTargetPreview(settings,Number(form.elements.targetOffset.value),Number(form.elements.awayOffset.value));
  const target=room.priority==='low'?targets.low:targets.high;
  const correction=brightness=>{
   const amount=sunTargetReduction(target,value,brightness);
   return `${amount>0?'−':''}${fixed(amount,2)}°C`;
  };
  const sun=room.sunCompensation,brightness=room.fresh&&!room.emergencyHeating&&room.current>=7?sun?.brightness:null;
  output.textContent=`${value}%`;
  slider.setAttribute('aria-valuetext',`${value}%, ${correction(1)} in clear sun`);
  preview.textContent=`Heating target · Clear ${correction(1)} · 50% cloud ${correction(.5)}${Number.isFinite(brightness)?` · Now ${correction(brightness)}`:''}`;
 };
 form.addEventListener('input',update);
 form.addEventListener('change',update);
 update();
}
