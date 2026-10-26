import test from 'node:test';
import assert from 'node:assert/strict';
import {normalisePoints,nearestIndex,chartShell,reduceLine,lineTooltipPlacement,nearestChartLine} from '../public/charts.js';
import {time,dateTime,clockTime,clockValue,clockInput} from '../public/ui.js';

test('line labels stay within the plot while the readout occupies its own column',()=>{
 for(const width of [240,375,600,985])for(const height of [150,340])for(const labelWidth of [120,Math.min(230,width-16)])for(const px of [58,width/2,width-18])for(const py of [22,height/2,height-44]){
  const result=lineTooltipPlacement(width,height,px,py,labelWidth,30);
  assert.ok(result.left>=8&&result.left+labelWidth<=width-8);
  assert.ok(result.top>=8&&result.top+30<=height-8);
 }
 const html=chartShell('separate-panel','Temperatures');
 assert.match(html,/<div class="chart-plot-area"><svg/);
 assert.ok(html.includes('</svg></div><aside class="chart-inspector"'));
 assert.match(html,/Hover or tap the graph to inspect readings/);
});

test('line hover identifies the nearest rendered line, including slopes and close neighbours',()=>{
 const office={key:'office'},bedroom={key:'bedroom'},target={key:'target',dashed:true};
 const lines=[
  {series:office,points:[{x:20,y:100},{x:120,y:200}]},
  {series:bedroom,points:[{x:20,y:106},{x:120,y:206}]},
  {series:target,points:[{x:20,y:60},{x:120,y:60}]}
 ];
 assert.equal(nearestChartLine(lines,70,150).series,office);
 assert.equal(nearestChartLine(lines,70,156).series,bedroom);
 assert.equal(nearestChartLine(lines,70,65).series,target);
 assert.equal(nearestChartLine(lines,70,20),null);
 assert.equal(nearestChartLine([],70,150),null);
});

test('line hover does not bridge missing readings, outages or remote endpoints',()=>{
 const lines=[{series:{key:'office'},points:[{x:20,y:100},{x:40,y:100},null,{x:100,y:100},{x:120,y:100}]}];
 assert.equal(nearestChartLine(lines,70,100),null);
 assert.equal(nearestChartLine(lines,0,100),null);
 assert.equal(nearestChartLine(lines,120,109).series.key,'office');
 assert.equal(nearestChartLine([{series:{key:'single'},points:[{x:20,y:50}]}],20,50).series.key,'single');
});

test('chart points preserve real timestamps, merge simultaneous register values and retain gaps',()=>{
 const points=normalisePoints([{at:'2026-10-22T10:00:30Z',flow:43},{at:'invalid',flow:900},{at:'2026-10-22T10:00:00Z',flow:42},{at:'2026-10-22T10:00:00Z',return:35},{at:'2026-10-22T10:02:00Z',flow:null}]);
 assert.equal(points.length,3);assert.equal(points[0].return,35);assert.equal(points[2].flow,null);assert.equal(nearestIndex(points,points[0].time+20000),1);assert.equal(nearestIndex([],0),-1);
});
test('chart shells expose zoom, CSV and keyboard inspection without interpolated readings',()=>{const html=chartShell('chart-test','Temperature <readings>');assert.match(html,/data-chart-action="csv"/);assert.match(html,/Reset view/);assert.match(html,/left and right arrows/);assert.ok(!html.includes('Temperature <readings>'));});

test('week-scale line rendering preserves extrema and actual gaps while bounding SVG size',()=>{
 const rows=Array.from({length:20160},(_,i)=>({time:i*30000,value:i===500?80:i===501?-5:40}));rows[600].value=null;
 const result=reduceLine(rows,'value',[0,20160*30000],800,90000);
 assert.ok(result.length<3300);assert.ok(result.some(row=>row?.value===80));assert.ok(result.some(row=>row?.value===-5));assert.ok(result.includes(null));assert.equal(result[0],rows[0]);assert.equal(result.at(-1),rows.at(-1));
 const gap=reduceLine([{time:0,value:1},{time:90001,value:2}],'value',[0,100000],1,90000);assert.equal(gap[1],null);
});

test('all displayed clock values use am/pm including noon, midnight and UK clock changes',()=>{
 assert.equal(clockTime('00:05'),'12:05 am');assert.equal(clockTime('12:30'),'12:30 pm');assert.equal(clockTime('23:59'),'11:59 pm');
 assert.equal(clockValue('12','05','am'),'00:05');assert.equal(clockValue('12','30','pm'),'12:30');assert.equal(clockValue('11','59','pm'),'23:59');
 assert.match(time('2026-10-22T20:51:00Z'),/9:51 pm/);assert.match(time('2026-10-25T00:30:00Z'),/1:30 am/);assert.match(time('2026-10-25T01:30:00Z'),/1:30 am/);
 assert.match(dateTime('2026-10-22T20:51:00Z','Europe/London',{second:'2-digit'}),/9:51:00 pm/);
 const html=clockInput('Start','start','23:59');assert.ok(!html.includes('type="time"'));assert.match(html,/name="start" value="23:59"/);assert.match(html,/value="pm" selected/);
});
