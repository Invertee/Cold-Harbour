// Shared by the controller and the previews so the displayed response matches
// the requested response. Valve travel is not a measurement of water flow.
export const defaultWeatherPlan={enabled:false,entityId:'',forecastEntityId:'',staleMinutes:120,designOutdoor:-3,minFlow:35,maxFlow:52,deficitGain:5,maxPreheatMinutes:180,flowOffset:0,curveExponent:1,taperBand:0};
export const defaultRoomControl={startBelow:0.2,stopBelow:0,fullOpenBelow:2,minOpening:10,maxOpening:100,openingMode:'proportional',fixedOpening:50};
const clamp=(n,low,high)=>Math.max(low,Math.min(high,n));

export const roomControl=room=>({...defaultRoomControl,...room.heatControl});
export const heatingTarget=room=>room.heatingTarget ?? room.target;
export const heatingDeficit=room=>room.controlDeficit ?? room.deficit;
export function roomThresholds(room){
 const control=roomControl(room),target=heatingTarget(room);
 return {opensBelowC:target-control.startBelow,closesAtC:target-control.stopBelow,fullOpenAtC:target-control.fullOpenBelow};
}
export function requestedOpening(room){
 if(!room.fresh||!room.callingForHeat||room.budgetPaused)return 0;
 const control=roomControl(room);
 const proportional=Math.ceil(clamp((heatingDeficit(room)-control.stopBelow)/(control.fullOpenBelow-control.stopBelow),0,1)*control.maxOpening/5)*5;
 return clamp(control.openingMode==='fixed'?control.fixedOpening:proportional,control.minOpening,control.maxOpening);
}
export function curveFlow(target,outdoor,settings){
 const w={...defaultWeatherPlan,...settings},load=clamp((target-outdoor)/(target-w.designOutdoor),0,1);
 return clamp(w.minFlow+(w.maxFlow-w.minFlow)*load**w.curveExponent+w.flowOffset,w.minFlow,w.maxFlow);
}
export function plannedFlow(baseFlow,deficit,settings,stopBelow=0){
 const w={...defaultWeatherPlan,...settings},correction=Math.max(0,deficit)*w.deficitGain;
 const beforeTaper=clamp(baseFlow+correction,w.minFlow,w.maxFlow);
 const fraction=w.taperBand>0?clamp((deficit-stopBelow)/w.taperBand,0,1):1;
 const flow=w.minFlow+(beforeTaper-w.minFlow)*fraction;
 return {flowC:flow,correctionC:correction,taperReductionC:beforeTaper-flow,taperFraction:fraction};
}
