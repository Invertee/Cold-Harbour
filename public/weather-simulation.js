import {esc,fixed} from './ui.js';
import {defaultWeatherPlan,curveFlow,plannedFlow,roomControl,requestedOpening} from './heating-model.js';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

// Follow the heating branch of the controller: a room already warming keeps
// calling until its early-stop temperature. A closed valve reopens later.
export function heatingScenario({weather,target,inside,outside,room={},warming=true}){
 const w={...defaultWeatherPlan,...weather},control=roomControl(room),frost=inside<7;
 const sunReduction=frost?0:Math.min(Math.max(0,target-7),room.sunCompensation?.reductionC || 0);
 const heatingTarget=target-sunReduction,deficit=heatingTarget-inside;
 const calling=frost||deficit>(warming?control.stopBelow:control.startBelow);
 const baseFlow=w.enabled?curveFlow(target,outside,w):w.minFlow;
 const response=plannedFlow(baseFlow,deficit,w,control.stopBelow);
 const flowC=calling?Math.min(response.flowC,frost?40:w.maxFlow):0;
 const opening=requestedOpening({...room,current:inside,target,heatingTarget,deficit:target-inside,controlDeficit:deficit,fresh:true,callingForHeat:calling,budgetPaused:false});
 return {flowC,opening,baseFlowC:baseFlow,calling,frost,sunReduction,taperReductionC:calling?response.taperReductionC:0,
  stopC:Math.max(7,heatingTarget-control.stopBelow),reopenC:Math.max(7,heatingTarget-control.startBelow),
  taperStartsC:heatingTarget-control.stopBelow-w.taperBand};
}

export function flowCurve(options){
 const current=heatingScenario(options),min=Math.max(5,Math.min(options.target-5,options.inside-.5)),max=Math.min(30,Math.max(options.target+1,options.inside+.5));
 // Include the switching boundary on both sides so the drop to "off" is
 // visible rather than drawing a gradual ramp below the minimum flow.
 const xs=new Set(Array.from({length:201},(_,i)=>min+(max-min)*i/200));
 for(const point of [7,current.stopC,current.taperStartsC,options.inside])for(const delta of [-.00001,0,.00001])if(point+delta>=min&&point+delta<=max)xs.add(point+delta);
 return {min,max,current,points:[...xs].sort((a,b)=>a-b).map(inside=>({inside,...heatingScenario({...options,inside})}))};
}

const validWeather=w=>[
 ['minFlow',25,60],['maxFlow',30,75],['designOutdoor',-30,0],['deficitGain',0,15],['flowOffset',-20,20],['curveExponent',.25,3],['taperBand',0,5],
].every(([key,min,max])=>Number.isFinite(w[key])&&w[key]>=min&&w[key]<=max)&&w.maxFlow>=w.minFlow;

export function weatherSimulationMarkup(rooms,selected=''){
 const slider=(key,label,min,max)=>`<label class="weather-model-slider" for="model-${key}"><span>${label}<output for="model-${key}" data-model-value="${key}"></output></span><input type="range" id="model-${key}" data-model-input="${key}" min="${min}" max="${max}" step="0.1"><small><span>${min}°C</span><span>${max}°C</span></small></label>`;
 return `<section class="weather-model" aria-labelledby="weather-model-title"><div class="weather-model-heading"><div><h3 id="weather-model-title">Try the heating response</h3><p class="field-help">Adjust the temperatures to see the flow request as a room warms towards its target.</p></div><button type="button" class="text-link" data-model-reset>Reset preview</button></div><div class="weather-model-controls"><label>Room response<select data-model-room><option value="">Standard room</option>${rooms.map(r=>`<option value="${esc(r.id)}" ${r.id===selected?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label>${slider('outside','Outside temperature',-30,35)}${slider('inside','Room temperature',5,30)}${slider('target','Target temperature',7,28)}</div><div class="weather-model-result" role="status" aria-live="polite"></div><p class="form-error" data-model-error role="alert" hidden>Complete the flow settings above with valid values to see the graph.</p><svg class="weather-model-plot" tabindex="0" role="img" aria-label="Planned boiler flow as the room warms. Adjust the room temperature with left and right arrows."></svg><div class="weather-model-key"><span><i class="model-key-line"></i>Planned flow</span><span><i class="model-key-taper"></i>Near-target taper</span><span><i class="model-key-stop"></i>Heating stops</span></div><p class="field-help" data-model-explanation></p><p class="field-help">Drag the marker or use the sliders. Preview temperatures are for exploring only. The curve uses the heating settings above; Save heating plan applies those settings. This models one room leading demand; other rooms, budget pauses and the boiler’s own limits can change the live result.</p></section>`;
}

export function mountWeatherSimulation(root,{weather,rooms=[],target=20,outside=10,leadRoomId=null}){
 let settings={...defaultWeatherPlan,...weather},room=rooms.find(r=>r.id===leadRoomId) || {},width=800,dragging=false;
 const initial={target, outside},values={};
 root.innerHTML=weatherSimulationMarkup(rooms,room.id);
 const svg=root.querySelector('svg'),result=root.querySelector('.weather-model-result'),error=root.querySelector('[data-model-error]'),explanation=root.querySelector('[data-model-explanation]');
 const sliders=Object.fromEntries(['inside','outside','target'].map(key=>[key,root.querySelector(`[data-model-input="${key}"]`)]));
 const reset=()=>{
  values.target=clamp(room.target ?? initial.target,7,28);values.inside=clamp(Number.isFinite(room.current)?room.current:values.target-2,5,30);values.outside=clamp(initial.outside,-30,35);
  for(const [key,slider] of Object.entries(sliders))slider.value=String(values[key]);
  draw();
 };
 function draw(){
  for(const [key,slider] of Object.entries(sliders)){
   values[key]=Number(slider.value);root.querySelector(`[data-model-value="${key}"]`).textContent=`${fixed(values[key])}°C`;slider.setAttribute('aria-valuetext',`${fixed(values[key])} degrees Celsius`);
  }
  const valid=validWeather(settings);error.hidden=valid;svg.style.display=valid?'':'none';
  if(!valid){result.textContent='Preview waiting for valid heating settings.';explanation.textContent='';return;}
  width=Math.max(260,Math.round(root.clientWidth || width));
  const height=width<500?270:320,left=45,right=18,top=30,bottom=48;
  const options={weather:settings,room,...values},curve=flowCurve(options),current=curve.current,maxFlow=Math.ceil(settings.maxFlow/10)*10;
  const x=value=>left+(value-curve.min)/(curve.max-curve.min)*(width-left-right),y=value=>height-bottom-value/maxFlow*(height-top-bottom);
  const line=curve.points.map((p,i)=>`${i?'L':'M'}${x(p.inside).toFixed(2)},${y(p.flowC).toFixed(2)}`).join(' ');
  const grid=Array.from({length:5},(_,i)=>{const value=i*maxFlow/4;return `<line class="model-grid" x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}"/><text x="${left-9}" y="${y(value)+4}" text-anchor="end">${fixed(value,0)}</text>`;}).join('');
  const steps=width<500?3:5,ticks=Array.from({length:steps+1},(_,i)=>{const value=curve.min+(curve.max-curve.min)*i/steps;return `<text x="${x(value)}" y="${height-bottom+22}" text-anchor="middle">${fixed(value)}</text>`;}).join('');
  const taperLeft=x(clamp(current.taperStartsC,curve.min,curve.max)),stop=x(clamp(current.stopC,curve.min,curve.max));
  const taper=settings.taperBand>0?`<rect class="model-taper-band" x="${taperLeft}" y="${top}" width="${Math.max(0,stop-taperLeft)}" height="${height-top-bottom}"/>`:'';
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  svg.innerHTML=`<title>Planned flow as the room warms</title><desc>${fixed(values.outside)} degrees outside. At ${fixed(values.inside)} degrees indoors, the flow request is ${fixed(current.flowC)} degrees. Heating stops at ${fixed(current.stopC,2)} degrees indoors.</desc>${taper}${grid}<text x="${left}" y="15">Boiler flow °C</text>${ticks}<text x="${(left+width-right)/2}" y="${height-5}" text-anchor="middle">Room temperature °C →</text><line class="model-stop-line" x1="${stop}" y1="${top}" x2="${stop}" y2="${height-bottom}"/><path class="model-flow-fill" d="${line} L${x(curve.max)},${y(0)} L${x(curve.min)},${y(0)} Z"/><path class="model-flow-line" d="${line}"/><line class="model-current-line" x1="${x(values.inside)}" y1="${top}" x2="${x(values.inside)}" y2="${height-bottom}"/><circle class="model-current-point" cx="${x(values.inside)}" cy="${y(current.flowC)}" r="6"/>`;
  const status=current.frost?'Frost protection':current.calling?'Heating':values.inside<values.target?'Coasting to target':'Target reached';
  result.innerHTML=`<strong>${current.calling?`${fixed(current.flowC)}<small>°C flow</small>`:'Heating off'}</strong><span>${status} · ${fixed(values.inside)}°C inside · ${fixed(values.outside)}°C outside${current.calling?` · ${current.opening}% valve opening`:''}</span>`;
  explanation.textContent=`The line follows an already-heating room. Heating stops at ${fixed(current.stopC,2)}°C; a stopped room reopens below ${fixed(current.reopenC,2)}°C. ${settings.taperBand>0?'The shaded area shows the near-target taper.':'Near-target taper is off; set a taper band above for a gradual reduction before stopping.'}${!settings.enabled?' Outside weather compensation is off, so changing the outside temperature has no effect.':''}${current.sunReduction>0?' Includes this room’s current sunshine allowance.':''}`;
 }
 for(const slider of Object.values(sliders))slider.addEventListener('input',draw);
 root.querySelector('[data-model-room]').onchange=event=>{room=rooms.find(r=>r.id===event.target.value) || {};reset();};
 root.querySelector('[data-model-reset]').onclick=reset;
 function setInside(event){
  const bounds=svg.getBoundingClientRect(),curve=flowCurve({weather:settings,room,...values});
  const position=(event.clientX-bounds.left)/bounds.width*width;
  sliders.inside.value=String(Math.round(clamp(curve.min+(position-45)/(width-45-18)*(curve.max-curve.min),5,30)*10)/10);draw();
 }
 svg.onpointerdown=event=>{if(event.button!==0||!validWeather(settings))return;dragging=true;svg.setPointerCapture(event.pointerId);setInside(event);};
 svg.onpointermove=event=>{if(dragging)setInside(event);};
 svg.onpointerup=event=>{dragging=false;if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);};
 svg.onpointercancel=()=>{dragging=false;};
 svg.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();sliders.inside.value=String(values.inside+(event.key==='ArrowRight'?0.1:-0.1));draw();};
 const observer=new ResizeObserver(()=>{if(root.clientWidth>0)draw();});observer.observe(root);reset();
 return {update(next){settings={...defaultWeatherPlan,...next};draw();},destroy(){observer.disconnect();}};
}
