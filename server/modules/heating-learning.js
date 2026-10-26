const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
export function weatherLearning(sessions){
 const matched=sessions.filter(s=>!s.ongoing&&s.weatherCoverage>=0.8&&Number.isFinite(s.meanOutdoorC));
 const bands=new Map();for(const s of matched){const low=Math.floor(s.meanOutdoorC/5)*5;if(!bands.has(low))bands.set(low,[]);bands.get(low).push(s);}
 let correlation=null;
 if(matched.length>=3&&Math.max(...matched.map(s=>s.meanOutdoorC))-Math.min(...matched.map(s=>s.meanOutdoorC))>=2){
  const x=mean(matched.map(s=>s.meanOutdoorC)),y=mean(matched.map(s=>s.minutes/s.rise));let xy=0,xx=0,yy=0;
  for(const s of matched){const a=s.meanOutdoorC-x,b=s.minutes/s.rise-y;xy+=a*b;xx+=a*a;yy+=b*b;}
  if(xx>0&&yy>0)correlation=xy/Math.sqrt(xx*yy);
 }
 return {matchedSessions:matched.length,calibrationSessions:matched.filter(s=>Number.isFinite(s.meanFlowC)).length,correlation,bands:[...bands].sort((a,b)=>a[0]-b[0]).map(([low,rows])=>({lowC:low,highC:low+5,sessions:rows.length,minutesPerC:rows.reduce((a,s)=>a+s.minutes,0)/rows.reduce((a,s)=>a+s.rise,0),meanFlowC:mean(rows.map(s=>s.meanFlowC).filter(Number.isFinite))})),outdoorRange:matched.length?[Math.min(...matched.map(s=>s.meanOutdoorC)),Math.max(...matched.map(s=>s.meanOutdoorC))]:null};
}

export function predictWarmup(insight,room,outdoorC,flowC,outdoorEntity=null){
 if(!room.fresh||!Number.isFinite(outdoorC)||!Number.isFinite(flowC))return null;
 const comparable=(insight?.evidence || []).filter(s=>!s.ongoing&&s.weatherCoverage>=0.8&&Number.isFinite(s.initialC)&&Math.abs(s.initialC-room.current)<=2&&Number.isFinite(s.meanOutdoorC)&&Number.isFinite(s.meanFlowC)&&Math.abs(s.meanOutdoorC-outdoorC)<=3&&Math.abs(s.meanFlowC-flowC)<=5&&s.sensorFingerprint===room.sensorFingerprint&&(s.radiatorEntity || '')===(room.radiatorEntity || '')&&(!outdoorEntity||s.outdoorEntity===outdoorEntity));
 const days=new Set(comparable.map(s=>s.start.slice(0,10))).size;
 if(comparable.length<3||days<2)return null;
 const minutes=comparable.reduce((sum,s)=>sum+s.minutes,0),rise=comparable.reduce((sum,s)=>sum+s.rise,0);
 return {minutesPerC:minutes/rise,lowMinutesPerC:Math.min(...comparable.map(s=>s.minutes/s.rise)),highMinutesPerC:Math.max(...comparable.map(s=>s.minutes/s.rise)),sessions:comparable.length,days,confidence:comparable.length>=6&&days>=3?'supported':'early'};
}
