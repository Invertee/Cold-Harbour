export function exchangeHealth(rows,now=Date.now(),rejections=[]){
 const cutoff=now-900000,recent=rows.filter(r=>Date.parse(r.at)>=cutoff&&Date.parse(r.at)<=now);
 let increase=0,comparable=0,longest=0;
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1],b=rows[i];if(Date.parse(b.at)<cutoff||Date.parse(b.at)>now)continue;
  longest=Math.max(longest,(Date.parse(b.at)-Math.max(cutoff,Date.parse(a.at)))/1000);
  if(a.boot_id===b.boot_id&&Number.isFinite(a.failures)&&Number.isFinite(b.failures)&&b.failures>=a.failures){increase+=b.failures-a.failures;comparable++;}
 }
 const latest=rows.filter(r=>Date.parse(r.at)<=now).at(-1);
 if(latest)longest=Math.max(longest,(now-Math.max(cutoff,Date.parse(latest.at)))/1000);
 const rejected=rejections.filter(r=>now-r.at>=0&&now-r.at<=900000);
 return {windowMinutes:15,accepted:recent.length,reportedFailureIncrease:comparable?increase:null,longestGapSeconds:latest?Math.round(longest):null,
  lastReceivedAt:latest?.at || null,totalSinceBoot:latest?.failures ?? null,rejected:rejected.reduce((n,r)=>n+r.count,0),
  lastRejection:rejected.at(-1)?.status || null,
  explanation:'The ESP total counts failed or rejected Cold Harbour HTTP exchanges since its last restart, not OpenTherm bus errors. The increase is when failures were reported; failures during an outage cannot be timed individually.'};
}
