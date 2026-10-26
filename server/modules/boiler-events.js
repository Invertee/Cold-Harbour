const fields=[['controller','Controller'],['thermal_context','Boiler phase'],['flame','Flame'],['ch_active','Central heating'],['dhw_active','Hot water'],['boiler_fault','Boiler fault'],['frost_active','Frost protection'],['comfort_enabled','Central heating permission'],['remote_active','Remote control'],['pid_available','Local PID ready']];
const value=(row,key)=>key==='controller'?row.telemetry.effective_mode || row.mode:row.telemetry[key];
const label=value=>value==null?'Not reported':typeof value==='boolean'?value?'On':'Off':String(value).replaceAll('_',' ');

// Temperatures, modulation and counters belong in time-series history. Emit an
// event only for a change of operating state, restart or restored connection.
export function boilerEvents(rows,baseline=null){
  const events=[];let previous=baseline;
  for(const row of rows){
    const changes=[];
    if(!previous)changes.push('Controller connected');
    else{
      if(row.boot_id!==previous.boot_id)changes.push('Controller restarted');
      if(Date.parse(row.at)-Date.parse(previous.at)>=90000)changes.push('Connection restored after a gap');
      for(const [key,name] of fields){const before=value(previous,key),after=value(row,key);if(before!==after)changes.push(`${name}: ${label(before)} → ${label(after)}`);}
    }
    if(changes.length)events.push({...row,summary:changes.join(' · ')});
    previous=row;
  }
  return events;
}
