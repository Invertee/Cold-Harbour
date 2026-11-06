import {esc} from './ui.js';

export const sunImpactLabel=value=>value<=0?'None':value<=25?'Low':value<=50?'Moderate':value<=75?'High':'Very high';

export function roomSunFields(room){
 const value=room.sunExposure ?? 0,label=sunImpactLabel(value);
 return `<section class="room-sun"><div class="room-sun-heading"><label for="room-sun-impact">Sun impact</label><output for="room-sun-impact" data-sun-label>${label}</output></div><input id="room-sun-impact" name="sunExposure" type="range" min="0" max="100" step="5" value="${esc(value)}" aria-valuetext="${label}" aria-describedby="room-sun-help"><div class="room-sun-scale" aria-hidden="true"><span>None</span><span>Very high</span></div><p id="room-sun-help" class="field-help">How much does sunshine warm this room? Move right for sunny rooms like the kitchen. Heating eases automatically as skies clear during daylight, using your existing weather data.</p></section>`;
}

export function bindRoomSun(form){
 const slider=form.elements.sunExposure,output=form.querySelector('[data-sun-label]');
 const update=()=>{const label=sunImpactLabel(Number(slider.value));output.textContent=label;slider.setAttribute('aria-valuetext',label);};
 slider.addEventListener('input',update);update();
}

export function roomSunStatus(room){
 const sun=room.sunCompensation;
 if(!sun||sun.status==='disabled')return '';
 const text=sun.reductionC>0?'Sunshine · heating eased':sun.status==='night'?'Sun impact · night':sun.status==='frost'?'Sun impact · frost protection':sun.status==='current'?'Sun impact · overcast':sun.status==='room_unavailable'?'Sun impact · awaiting room reading':sun.status==='daylight_unavailable'?'Sun impact · awaiting daylight data':'Sun impact · awaiting weather';
 return `<p class="room-sun-status">${text}</p>`;
}
