export const TREND_WINDOW_MINUTES=20;
const windowMs=TREND_WINDOW_MINUTES*60000;

// Use distinct source reports, rather than repeated polls of a cached temperature.
// A fitted line smooths small fluctuations without depending on heating being on.
export function roomTemperatureTrends(samples,rooms,now=Date.now()){
 return Object.fromEntries(rooms.map(room=>{
  const unavailable={direction:'unavailable',windowMinutes:TREND_WINDOW_MINUTES,changeC:null,minutes:null,readings:0};
  if(!room.fresh||!Number.isFinite(room.current)||!room.sensorFingerprint)return [room.id,unavailable];
  let points=[],lastSampleAt=null;
  const observations=[...samples,{at:new Date(now).toISOString(),rooms:[room]}];
  for(const sample of observations){
   const at=Date.parse(sample.at),reading=sample.rooms.find(r=>r.id===room.id),sourceAt=Date.parse(reading?.sourceAt);
   if(!Number.isFinite(at)||at<now-windowMs||at>now)continue;
   if(lastSampleAt!==null&&at-lastSampleAt>150000)points=[];
   lastSampleAt=at;
   if(!Number.isFinite(reading?.current)||!Number.isFinite(sourceAt)||reading.sensorFingerprint!==room.sensorFingerprint){points=[];continue;}
   if(sourceAt<now-windowMs||sourceAt>now||sourceAt>at+60000)continue;
   const previous=points.at(-1);
   if(previous?.at===sourceAt)continue;
   if(previous&&(sourceAt<previous.at||sourceAt-previous.at>10*60000))points=[];
   points.push({at:sourceAt,value:reading.current});
  }
  const first=points[0],last=points.at(-1),minutes=first&&last?(last.at-first.at)/60000:0;
  if(points.length<3||minutes<10||now-last.at>5*60000)return [room.id,{...unavailable,readings:points.length}];
  const meanX=points.reduce((sum,p)=>sum+(p.at-first.at)/60000,0)/points.length,meanY=points.reduce((sum,p)=>sum+p.value,0)/points.length;
  let numerator=0,denominator=0;
  for(const p of points){const x=(p.at-first.at)/60000-meanX;numerator+=x*(p.value-meanY);denominator+=x*x;}
  const changeC=Math.round(numerator/denominator*minutes*1000)/1000;
  return [room.id,{direction:changeC>=0.1?'rising':changeC<=-0.1?'falling':'stable',windowMinutes:TREND_WINDOW_MINUTES,changeC,minutes,readings:points.length}];
 }));
}
