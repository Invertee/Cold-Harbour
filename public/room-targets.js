import {esc,fixed,input,select} from './ui.js';

export function roomTemperaturePreferences(room,settings){
 const preference=(name,title,reference,value,max)=>`<fieldset class="room-temperature-preference"><legend class="sr-only">${title}</legend><h4 class="room-preference-title" aria-hidden="true">${title}</h4>${select('This room should be',`${name}Direction`,[['same','The same temperature'],['warmer','Warmer'],['cooler','Cooler']],value>0?'warmer':value<0?'cooler':'same')}${input('By how many °C?',`${name}Amount`,Math.abs(value),`type="number" min="0" max="${max}" step="any" required ${value===0?'disabled':''}`)}<input type="hidden" name="${name}" value="${esc(value)}"><p data-room-target="${name}" role="status" aria-live="polite"></p></fieldset>`;
 return `<h3>Room temperatures</h3><p class="field-help">Set this room’s comfort and low-priority targets.</p><div class="form-grid">${preference('targetOffset','When High · comfort','house',room.targetOffset ?? (room.id?room.comfort-20:0),10)}${preference('awayOffset','When Low · reduced heating','Low',room.awayOffset ?? (room.id?room.eco-16:0),15)}</div>`;
}

export function preferenceDifference(direction,amount){
 return direction==='same'?0:(direction==='cooler'?-1:1)*Number(amount);
}

export function roomTargetPreview(settings,highDifference,lowDifference){
 const high=Math.max(7,Math.min(28,settings.houseTarget+highDifference));
 const requestedLow=settings.awayTarget+lowDifference,low=Math.max(7,Math.min(high,requestedLow));
 return {
  high,low,
  highText:`Target: ${fixed(high)}°C${high!==settings.houseTarget+highDifference?' · limited to 7–28°C':''}`,
  lowText:`Target: ${fixed(low)}°C${requestedLow>high?' · capped at High target':requestedLow<7?' · 7°C minimum':''}`,
 };
}

export function bindRoomTemperaturePreferences(form,settings){
 const update=()=>{
  for(const name of ['targetOffset','awayOffset']){
   const direction=form.elements[`${name}Direction`].value,amount=form.elements[`${name}Amount`];
   amount.disabled=direction==='same';
   form.elements[name].value=String(preferenceDifference(direction,amount.value));
  }
  const preview=roomTargetPreview(settings,Number(form.elements.targetOffset.value),Number(form.elements.awayOffset.value));
  for(const [name,text] of [['targetOffset',preview.highText],['awayOffset',preview.lowText]])form.querySelector(`[data-room-target="${name}"]`).textContent=text;
 };
 for(const name of ['targetOffset','awayOffset']){
  form.elements[`${name}Direction`].addEventListener('change',update);
  form.elements[`${name}Amount`].addEventListener('input',update);
 }
 update();
}
