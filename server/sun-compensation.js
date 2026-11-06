const fresh=(state,now,maxAge)=>{
 const at=Date.parse(state?.last_reported || state?.last_updated);
 return state&&!['unknown','unavailable',''].includes(state.state)&&Number.isFinite(at)&&now-at<=maxAge&&at-now<=60000;
};

// Cloud cover is a rough proxy for solar gain, not a measurement of heat
// entering a room. Daylight must be known before it can reduce heating.
export function sunlightReading(settings={},states,now){
 const entityId=settings.forecastEntityId || (settings.entityId?.startsWith('weather.')?settings.entityId:''),maxAge=(settings.staleMinutes ?? 120)*60000;
 const weather=states.find(s=>s.entity_id===entityId),sun=states.find(s=>s.entity_id==='sun.sun');
 const result={entityId,brightness:0,status:'unavailable'};
 if(!fresh(weather,now,maxAge))return result;
 const attributes=weather.attributes || {};
 const daylight=weather.state==='clear-night'?false:fresh(sun,now,maxAge)&&['above_horizon','below_horizon'].includes(sun.state)?sun.state==='above_horizon':typeof attributes.is_daytime==='boolean'?attributes.is_daytime:weather.state==='sunny'?true:null;
 if(daylight===false)return {...result,status:'night'};
 if(daylight===null)return {...result,status:'daylight_unavailable'};
 const cloud=attributes.cloud_coverage;
 const brightness=typeof cloud==='number'&&Number.isFinite(cloud)&&cloud>=0&&cloud<=100?1-cloud/100:({sunny:1,partlycloudy:0.5,cloudy:0})[weather.state];
 return brightness===undefined?result:{...result,brightness,status:'current'};
}

export function roomSunCompensation(room,target,current,sunlight){
 const impact=room.sunExposure ?? 0;
 const status=impact<=0?'disabled':current===null?'room_unavailable':current<7?'frost':sunlight.status;
 // A full slider allows up to 2°C of estimated solar warmth. Keep the
 // scheduled target separate, and never lower the 7°C protection floor.
 const reductionC=status==='current'?Math.min(Math.max(0,target-7),2*impact/100*sunlight.brightness):0;
 return {impact,status,reductionC,heatingTargetC:target-reductionC};
}
