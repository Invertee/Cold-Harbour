import {esc,dateTime} from './ui.js';
const teardowns=new Set();
export function destroyCharts(){for(const destroy of teardowns)destroy();teardowns.clear();}

export function normalisePoints(rows){
  const byTime=new Map();
  for(const row of rows){const at=Date.parse(row.at || row.start);if(!Number.isFinite(at))continue;byTime.set(at,{...byTime.get(at),...row,at:new Date(at).toISOString(),time:at});}
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}
export function nearestIndex(rows,time){
  if(!rows.length)return -1;let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].time<time)lo=mid+1;else hi=mid;}
  return lo===0?0:lo===rows.length?lo-1:time-rows[lo-1].time<=rows[lo].time-time?lo-1:lo;
}
export const chartColours=['#009e73','#0072ed','#e08000','#a23ddb','#009aaa','#dd367d','#7c8600','#e24a28'];
export function lineTooltipPlacement(width,height,px,py,labelWidth,labelHeight){
  const left=px+labelWidth+14<=width-8?px+14:px-labelWidth-14;
  return {left:Math.max(8,Math.min(width-labelWidth-8,left)),top:Math.max(8,Math.min(height-labelHeight-8,py-labelHeight-12))};
}
// Hit-test the rendered segments, including their real gaps and separate axes.
export function nearestChartLine(lines,px,py,radius=10){
  let nearest=null,best=radius*radius;
  for(const {series,points} of lines){
    let previous=null;
    for(const point of points){
      if(!point){previous=null;continue;}
      const a=previous || point,dx=point.x-a.x,dy=point.y-a.y,length=dx*dx+dy*dy;
      const t=length?Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/length)):0;
      const x=a.x+t*dx,y=a.y+t*dy,distance=(px-x)**2+(py-y)**2;
      if(distance<=best){best=distance;nearest={series,x,y};}
      previous=point;
    }
  }
  return nearest;
}
// Keep the real first/last and extrema in each screen pixel; tooltips and CSV
// still use every original reading. Explicit missing values break the line.
export function reduceLine(rows,key,range,pixels,maxGapMs){
  const out=[];let bucket=[],pixel=null,previous=null;
  const flush=()=>{if(!bucket.length)return;let low=bucket[0],high=low;for(const row of bucket){if(row[key]<low[key])low=row;if(row[key]>high[key])high=row;}out.push(...[...new Set([bucket[0],low,high,bucket.at(-1)])].sort((a,b)=>a.time-b.time));bucket=[];};
  for(const row of rows){
    if(row[key]===null){flush();if(previous)out.push(null);previous=null;pixel=null;continue;}
    if(!Number.isFinite(row[key]))continue;
    if(previous&&row.time-previous.time>maxGapMs){flush();out.push(null);pixel=null;}
    const next=Math.floor((row.time-range[0])/(range[1]-range[0])*pixels);
    if(pixel!==next){flush();pixel=next;}bucket.push(row);previous=row;
  }
  flush();return out;
}
export const chartShell=(id,label,{compact=false}={})=>`<div id="${esc(id)}" class="interactive-chart ${compact?'compact-chart':''}"><div class="chart-controls"><div class="chart-series" aria-label="Chart series"></div>${compact?'':`<div class="chart-actions"><button type="button" data-chart-action="out">Zoom out</button><button type="button" data-chart-action="reset">Reset view</button><button type="button" data-chart-action="csv">CSV</button></div>`}</div><div class="chart-stage"><div class="chart-layout"><div class="chart-plot-area"><svg class="chart-plot" tabindex="0" role="img" aria-label="${esc(label)}. Use left and right arrows to inspect readings." aria-describedby="${esc(id)}-help"></svg></div><aside class="chart-inspector" aria-label="Chart values"><div class="chart-tooltip" hidden></div><p class="chart-inspector-hint">Hover or tap the graph to inspect readings.</p></aside></div></div><div class="chart-footer-note"><span class="chart-range"></span><span id="${esc(id)}-help">${compact?'Hover or tap for values':'Drag to zoom · hover or tap for values · ← → to inspect'}</span></div><output class="sr-only chart-readout" aria-live="polite"></output></div>`;

export function bindChart(element,{rows,series,start,end,timezone='Europe/London',kind='line',unit='',compact=false,maxGapMs=90000,state={},extraTooltip=()=>[],extraExport=[],bands=[],bandStyles=[],references=[],rightUnit='%',rightDomain=[0,100],onRangeChange=()=>{}}){
  if(!element)return;
  const points=normalisePoints(rows),svg=element.querySelector('svg'),tooltip=element.querySelector('.chart-tooltip'),stage=element.querySelector('.chart-stage'),plotArea=element.querySelector('.chart-plot-area');
  const lineLabel=document.createElement('div');lineLabel.className='chart-line-label';lineLabel.hidden=true;plotArea.append(lineLabel);
  let hitLines=[],activeLine=null,lineAnchor=null;
  const clearLine=()=>{activeLine=null;lineAnchor=null;lineLabel.hidden=true;svg.querySelectorAll('.chart-line-active').forEach(path=>path.classList.remove('chart-line-active'));};
  const first=points[0]?.time ?? Date.now()-3600000,last=points.at(-1)?.time ?? Date.now();
  const fullStart=Number.isFinite(Date.parse(start))?Date.parse(start):first,fullEnd=Number.isFinite(Date.parse(end))?Date.parse(end):last;
  const full=[fullStart,Math.max(fullEnd,fullStart+1000)],hidden=new Set(state.hidden || []);
  let range=state.zoomed?[Math.max(full[0],state.start),Math.min(full[1],state.end)]:[...full];if(!(range[1]>range[0]))range=[...full];
  const hasRight=series.some(s=>s.axis==='right');
  let width=800,height=compact?150:340,left=compact?40:58,right=hasRight?54:18,top=22,bottom=compact?25:44,visible=[],minY=0,maxY=1,index=0,drag=null,pinned=false;
  const stamp=at=>dateTime(at,timezone,{day:'2-digit',month:'short',second:'2-digit',timeZoneName:'short'});
  const timeBands=bands.map(b=>({...b,from:Date.parse(b.start),until:Date.parse(b.end)})).filter(b=>Number.isFinite(b.from)&&b.until>b.from);
  const styles=new Map(bandStyles.map(b=>[b.key,b]));
  if(bandStyles.length){const legend=document.createElement('div');legend.className='chart-phase-legend';legend.innerHTML=`<span>Reported phase</span>${bandStyles.map(b=>`<span><i style="background:${b.colour}"></i>${esc(b.label)}</span>`).join('')}<span>Unshaded: unknown / no readings</span>`;element.querySelector('.chart-stage').before(legend);}
  const numberFormats=new Map();
  const number=(value,digits=2)=>{if(!Number.isFinite(value))return 'Not reported';if(!numberFormats.has(digits))numberFormats.set(digits,new Intl.NumberFormat('en-GB',{maximumFractionDigits:digits}));return numberFormats.get(digits).format(value);};
  function tooltipEntries(row){
    const entries=series.filter(s=>!hidden.has(s.key)).map(s=>[s.label,`${number(row[s.key],s.digits ?? 2)}${Number.isFinite(row[s.key])?' '+(s.unit || unit):''}`,s]);
    if(kind==='bar'&&row.end)entries.unshift(['Interval ends',stamp(row.end)]);
    if(bandStyles.length&&!row.thermal_context){const band=timeBands.find(b=>row.time>=b.from&&row.time<b.until);entries.push(['Reported phase',styles.get(band?.phase)?.label || 'Unknown / no readings']);}
    entries.push(...extraTooltip(row));return entries;
  }
  const swatch=s=>s?`<i class="chart-tooltip-swatch" style="background:${esc(s.colour)};${s.dashed?'background:none;border-top:2px dashed '+esc(s.colour):''}"></i>`:'';
  let sizingGroups=null;
  function sizeInspector(){
    // Measure every possible value before drawing. Each sizing cell stacks its
    // alternatives, reserving the tallest wrapped content without adding rows.
    if(!sizingGroups){
      const groups=new Map();
      for(const row of points)for(const [label,value,s] of tooltipEntries(row)){
        const key=JSON.stringify([label,s?.key]);if(!groups.has(key))groups.set(key,{label,series:s,values:new Set()});groups.get(key).values.add(String(value ?? ''));
      }
      sizingGroups=[...groups.values()];
    }
    const measure=document.createElement('div');measure.className='chart-tooltip chart-tooltip-measure';measure.setAttribute('aria-hidden','true');
    measure.innerHTML=`<strong>${esc(stamp(points.at(-1)?.time || full[1]))}</strong>${sizingGroups.map(group=>`<div${group.series?' class="chart-tooltip-active"':''}><span>${swatch(group.series)}${esc(group.label)}</span><b>${[...group.values].map(value=>`<span>${esc(value)}</span>`).join('')}</b></div>`).join('')}`;
    tooltip.parentElement.append(measure);
    height=Math.max(height,Math.ceil(measure.getBoundingClientRect().height)+2);measure.remove();
    element.style.setProperty('--chart-height',`${height}px`);
  }
  const x=time=>left+(time-range[0])/(range[1]-range[0])*(width-left-right),y=(value,s)=>height-bottom-(s?.axis==='right'?(value-rightDomain[0])/(rightDomain[1]-rightDomain[0]):(value-minY)/(maxY-minY))*(height-top-bottom);
  const setRange=(next,zoomed=true,notify=true)=>{range=[Math.max(full[0],next[0]),Math.min(full[1],next[1])];if(range[1]-range[0]<1000)return;Object.assign(state,{zoomed,start:range[0],end:range[1]});pinned=false;tooltip.hidden=true;draw();if(notify)onRangeChange(range,zoomed);};
  const legends=element.querySelector('.chart-series');
  legends.innerHTML=series.map(s=>`<button type="button" data-series="${esc(s.key)}" aria-pressed="${!hidden.has(s.key)}"><i style="background:${s.colour}"></i>${esc(s.label)}</button>`).join('');
  legends.querySelectorAll('button').forEach(button=>button.onclick=()=>{const key=button.dataset.series;if(hidden.has(key))hidden.delete(key);else hidden.add(key);state.hidden=[...hidden];button.setAttribute('aria-pressed',String(!hidden.has(key)));sizingGroups=null;draw();});
  function draw(){
    clearLine();tooltip.hidden=true;hitLines=[];
    width=Math.max(240,Math.round(plotArea.getBoundingClientRect().width || 800));
    sizeInspector();
    visible=points.filter(row=>kind==='bar'?row.time<=range[1]&&Date.parse(row.end)>range[0]:row.time>=range[0]&&row.time<=range[1]);
    const enabled=series.filter(s=>!hidden.has(s.key));let low=kind==='bar'?0:Infinity,high=kind==='bar'?0:-Infinity,valueCount=0;
    for(const row of visible)for(const s of enabled)if(Number.isFinite(row[s.key])){if(s.axis!=='right'){low=Math.min(low,row[s.key]);high=Math.max(high,row[s.key]);}valueCount++;}
    for(const ref of references){low=Math.min(low,ref.value);high=Math.max(high,ref.value);}
    if(Number.isFinite(low)){const pad=Math.max((high-low)*.12,unit==='°C'?1:.1);minY=kind==='bar'?Math.min(low,0):Math.floor((low-pad)*10)/10;maxY=Math.ceil((high+pad)*10)/10;}else{minY=0;maxY=1;}
    const nTicks=compact?2:4,ticks=Array.from({length:nTicks+1},(_,i)=>{const value=minY+(maxY-minY)*i/nTicks;return `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}" class="chart-grid-line"/><text x="${left-9}" y="${y(value)+4}" text-anchor="end">${number(value,1)}</text>`;}).join('');
    const rightTicks=hasRight?Array.from({length:nTicks+1},(_,i)=>{const value=rightDomain[0]+(rightDomain[1]-rightDomain[0])*i/nTicks;return `<text x="${width-right+9}" y="${y(value,{axis:'right'})+4}">${number(value,0)}</text>`;}).join('')+`<text x="${width-right}" y="14">${esc(rightUnit)}</text>`:'';
    const tickCount=width<550?3:6;
    const longRange=range[1]-range[0]>86400000;
    const tickStamp=at=>dateTime(at,timezone);
    const dayStamp=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,day:'numeric',month:'short'});
    const xTicks=Array.from({length:tickCount},(_,i)=>{const t=range[0]+(range[1]-range[0])*i/(tickCount-1),px=x(t);return `<text x="${px}" y="${height-(longRange?24:10)}" text-anchor="${i===0?'start':i===tickCount-1?'end':'middle'}">${longRange?`<tspan x="${px}">${esc(dayStamp.format(t))}</tspan><tspan x="${px}" dy="14">${esc(tickStamp(t))}</tspan>`:esc(tickStamp(t))}</text>`;}).join('');
    const backgrounds=timeBands.filter(b=>b.until>range[0]&&b.from<range[1]&&styles.has(b.phase)).map(b=>{const style=styles.get(b.phase),a=x(Math.max(range[0],b.from)),z=x(Math.min(range[1],b.until));return `<rect aria-hidden="true" class="chart-phase-band" x="${a}" y="${top}" width="${z-a}" height="${height-top-bottom}" fill="${style.colour}" fill-opacity="0.13"/>`;}).join('');
    const referenceMarks=references.map(ref=>`<line x1="${left}" x2="${width-right}" y1="${y(ref.value)}" y2="${y(ref.value)}" stroke="${ref.colour || '#8a6a35'}" stroke-dasharray="6 5"/><text x="${width-right-5}" y="${y(ref.value)-6}" text-anchor="end">${esc(ref.label)}</text>`).join('');
    let marks='';
    for(const s of enabled){
      if(kind==='bar'){
        marks+=visible.filter(row=>Number.isFinite(row[s.key])).map(row=>{const endTime=Date.parse(row.end),a=x(row.time),b=x(Math.min(range[1],Number.isFinite(endTime)?endTime:row.time+1800000));return `<rect x="${a+1}" y="${Math.min(y(0),y(row[s.key]))}" width="${Math.max(1,b-a-2)}" height="${Math.max(0.5,Math.abs(y(0)-y(row[s.key])))}" fill="${s.colour}"/>`;}).join('');
      }else{
        let d='',previous=null;const hitPoints=[];
        for(const row of reduceLine(visible,s.key,range,width-left-right,maxGapMs)){if(!row){previous=null;hitPoints.push(null);continue;}const px=x(row.time),py=y(row[s.key],s);hitPoints.push({x:px,y:py});d+=`${previous?'L':'M'}${px.toFixed(2)},${py.toFixed(2)} `;previous=row;}
        hitLines.push({series:s,points:hitPoints});
        marks+=`<path data-chart-line="${esc(s.key)}" d="${d}" stroke="${s.colour}" fill="none" stroke-width="2.5" ${s.dashed?'stroke-dasharray="6 4"':''} vector-effect="non-scaling-stroke"/>`;
        if(visible.length<100)marks+=visible.filter(row=>Number.isFinite(row[s.key])).map(row=>`<circle cx="${x(row.time)}" cy="${y(row[s.key],s)}" r="2.5" fill="${s.colour}"/>`).join('');
      }
    }
    const emptyText=!valueCount?`<text x="${width/2}" y="${height/2}" text-anchor="middle">No reported readings in this view</text>`:'';
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.style.height=`${height}px`;
    svg.innerHTML=`<defs><clipPath id="${element.id}-clip"><rect x="${left}" y="${top}" width="${width-left-right}" height="${height-top-bottom}"/></clipPath></defs><g clip-path="url(#${element.id}-clip)">${backgrounds}</g>${ticks}${rightTicks}${xTicks}<text x="${left}" y="14">${esc(unit)}</text><g clip-path="url(#${element.id}-clip)">${referenceMarks}${marks}</g>${emptyText}<line class="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${height-bottom}" visibility="hidden"/><rect class="chart-selection" x="0" y="${top}" width="0" height="${height-top-bottom}" visibility="hidden"/>`;
    element.querySelector('.chart-range').textContent=`${stamp(range[0])} – ${stamp(range[1])} · ${visible.length.toLocaleString()} readings`;
    const reset=element.querySelector('[data-chart-action="reset"]');if(reset)reset.disabled=!state.zoomed;
  }
  function inspectLine(event){
    clearLine();
    const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)*width/rect.width,py=(event.clientY-rect.top)*height/rect.height;
    if(px<left||px>width-right||py<top||py>height-bottom)return;
    const hit=nearestChartLine(hitLines,px,py);if(!hit)return;
    activeLine=hit.series.key;lineAnchor={x:px,y:py};
    svg.querySelectorAll('[data-chart-line]').forEach(path=>path.classList.toggle('chart-line-active',path.dataset.chartLine===activeLine));
  }
  function show(position,keyboard=false){
    if(!visible.length||position<0){clearLine();tooltip.hidden=true;svg.querySelector('.chart-crosshair')?.setAttribute('visibility','hidden');return;}index=Math.max(0,Math.min(visible.length-1,position));const row=visible[index];
    const entries=tooltipEntries(row);
    tooltip.innerHTML=`<strong>${esc(stamp(row.time))}</strong>${entries.map(([label,value,s])=>`<div${s&&s.key===activeLine?' class="chart-tooltip-active"':''}><span>${swatch(s)}${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}`;
    const px=x(row.time);tooltip.hidden=false;
    const activeEntry=entries.find(([, ,s])=>s&&s.key===activeLine);
    if(activeEntry&&lineAnchor){
      const [label,value,s]=activeEntry;
      lineLabel.innerHTML=`<i style="background:${esc(s.colour)}"></i>${esc(label)} <b>${esc(value)}</b>`;lineLabel.hidden=false;
      const position=lineTooltipPlacement(width,height,lineAnchor.x,lineAnchor.y,lineLabel.offsetWidth,lineLabel.offsetHeight);
      lineLabel.style.left=`${position.left}px`;lineLabel.style.top=`${position.top}px`;
    }
    const line=svg.querySelector('.chart-crosshair');line.setAttribute('x1',String(px));line.setAttribute('x2',String(px));line.setAttribute('visibility','visible');
    if(keyboard)element.querySelector('.chart-readout').textContent=`${stamp(row.time)}. ${entries.map(([label,value])=>`${label}: ${value}`).join('. ')}`;
  }
  const coord=event=>Math.max(left,Math.min(width-right,(event.clientX-svg.getBoundingClientRect().left)*width/svg.getBoundingClientRect().width));
  const pointAt=px=>{const t=range[0]+(px-left)/(width-left-right)*(range[1]-range[0]);let i=nearestIndex(visible,t);if(kind==='bar'&&i>=0){if(visible[i].time>t)i--;if(i<0||t>=Date.parse(visible[i].end))return -1;}return i;};
  const hide=()=>{if(pinned)return;clearLine();tooltip.hidden=true;svg.querySelector('.chart-crosshair')?.setAttribute('visibility','hidden');element.dataset.interacting='false';};
  svg.onpointerenter=()=>{element.dataset.interacting='true';};
  svg.onpointerleave=event=>{if(!stage.contains(event.relatedTarget))hide();};stage.onpointerleave=hide;
  svg.onpointerdown=event=>{if(event.button!==0)return;drag=coord(event);svg.setPointerCapture(event.pointerId);element.dataset.interacting='true';};
  svg.onpointermove=event=>{const px=coord(event);if(drag!==null&&Math.abs(px-drag)>8&&!compact){clearLine();const rect=svg.querySelector('.chart-selection');rect.setAttribute('x',String(Math.min(drag,px)));rect.setAttribute('width',String(Math.abs(px-drag)));rect.setAttribute('visibility','visible');tooltip.hidden=true;}else if(!pinned){inspectLine(event);show(pointAt(px));}};
  svg.onpointerup=event=>{const px=coord(event),from=drag;drag=null;svg.releasePointerCapture(event.pointerId);if(from!==null&&Math.abs(px-from)>12&&!compact){const scale=(range[1]-range[0])/(width-left-right);setRange([range[0]+(Math.min(from,px)-left)*scale,range[0]+(Math.max(from,px)-left)*scale]);}else{pinned=!pinned;inspectLine(event);show(pointAt(px));element.dataset.interacting=String(pinned);}svg.querySelector('.chart-selection')?.setAttribute('visibility','hidden');};
  svg.onpointercancel=()=>{drag=null;pinned=false;hide();svg.querySelector('.chart-selection')?.setAttribute('visibility','hidden');};
  svg.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();clearLine();pinned=true;element.dataset.interacting='true';show(event.key==='Home'?0:event.key==='End'?visible.length-1:index+(event.key==='ArrowRight'?1:-1),true);}else if(event.key==='Escape'){pinned=false;hide();}};
  svg.onblur=()=>{pinned=false;hide();};
  element.querySelectorAll('[data-chart-action]').forEach(button=>button.onclick=()=>{
    const action=button.dataset.chartAction;
    if(action==='reset')setRange([...full],false);
    if(action==='out'){const span=range[1]-range[0];setRange([range[0]-span/2,range[1]+span/2]);}
    if(action==='csv'){
      const columns=[['at','Timestamp'],...series.map(s=>[s.key,`${s.label} (${s.unit || unit})`]),...extraExport];
      const quote=value=>`"${String(value ?? '').replaceAll('"','""')}"`;
      const csv=[columns.map(([,label])=>quote(label)).join(','),...visible.map(row=>columns.map(([key])=>quote(row[key])).join(','))].join('\r\n');
      const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`cold-harbour-${element.id}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
  });
  draw();
  const resize=new ResizeObserver(()=>{
    if(!element.isConnected){resize.disconnect();return;}
    const nextWidth=Math.max(240,Math.round(plotArea.getBoundingClientRect().width || 800));
    if(nextWidth!==width){
      const inspecting=!tooltip.hidden,selected=index;
      draw();if(inspecting)show(selected);
    }
  });resize.observe(plotArea);
  const destroy=()=>{resize.disconnect();lineLabel.remove();teardowns.delete(destroy);};teardowns.add(destroy);return {destroy,setView:(next,zoomed=true)=>setRange(next,zoomed,false)};
}
