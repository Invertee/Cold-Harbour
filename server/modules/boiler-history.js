const phases=new Set(['domestic_hot_water','settling_after_hot_water','space_heating','idle']);
const chartFields=['flow_c','return_c','dhw_temperature_c','requested_flow_c','modulation_pct','flame','ch_active','dhw_active','heating_sample_valid','ch_flow_c','ch_return_c','opentherm_age_s'];

export function boilerPhase(reading){
  if(!(reading.opentherm_age_s<90))return 'unknown';
  if(reading.dhw_active===true||reading.dhw_flow_l_min>0.5)return 'domestic_hot_water';
  return phases.has(reading.thermal_context)?reading.thermal_context:'unknown';
}

export function heatingDelta(reading){
  if(boilerPhase(reading)!=='space_heating'||reading.heating_sample_valid!==true||reading.ch_active!==true||reading.dhw_active!==false)return null;
  // These fields have already passed the controller's post-DHW settling filter.
  if(!Number.isFinite(reading.ch_flow_c)||!Number.isFinite(reading.ch_return_c))return null;
  return Math.round((reading.ch_flow_c-reading.ch_return_c)*1000)/1000;
}

export function chartReading(at,reading){
  const point={at,thermal_context:boilerPhase(reading),heating_delta_c:heatingDelta(reading)};
  for(const field of chartFields)if(reading[field]!==undefined)point[field]=reading[field];
  return point;
}

export function phaseBands(points,end){
  const bands=[],endTime=Date.parse(end);
  for(let i=0;i<points.length;i++){
    const point=points[i],start=Date.parse(point.at),phase=point.thermal_context;
    if(!phases.has(phase))continue;
    // Never colour an outage as continued heating/hot water. Reports expire at 90 s.
    const until=Math.min(endTime,start+90000,i+1<points.length?Date.parse(points[i+1].at):endTime);
    if(until<=start)continue;
    const previous=bands.at(-1);
    if(previous?.phase===phase&&previous.end===point.at)previous.end=new Date(until).toISOString();
    else bands.push({start:point.at,end:new Date(until).toISOString(),phase});
  }
  return bands;
}
