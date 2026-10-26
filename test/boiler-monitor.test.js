import test from 'node:test';
import assert from 'node:assert/strict';
import {boilerOverview,boilerEventTable,captureMarkup,boilerDiagnosticsMarkup} from '../public/boiler-monitor.js';

const status={connected:true,selectedMode:'PID',deviceId:'test-device',lastSeen:'2026-10-26T20:00:00Z',telemetry:{effective_mode:'PID',flow_c:41.1,return_c:38,flame:false,ch_active:false,dhw_active:false}};
test('boiler overview separates actual state from planned settings and flags stale or faulted readings',()=>{
 const html=boilerOverview({status,phase:'idle'},null);
 assert.match(html,/Idle/);assert.match(html,/Local PID/);assert.match(html,/41.1/);assert.match(html,/38.0/);assert.match(html,/Diagnostics/);
 assert.doesNotMatch(html,/start-capture|commissioning-details|Failure increase/);
 const unavailable=boilerOverview({status:{...status,connected:false,telemetry:{...status.telemetry,boiler_fault:true,frost_active:true,comfort_enabled:false}},phase:'idle'},null);
 assert.match(unavailable,/Readings stale/);assert.match(unavailable,/Showing last reported values/);assert.match(unavailable,/Boiler fault reported/);assert.match(unavailable,/Frost protection active/);assert.match(unavailable,/Central heating paused/);
});
test('capture controls remain behind diagnostics and respect readiness and queued commands',()=>{
 const logs={rows:[]},zone='Europe/London';
 assert.match(captureMarkup({ready:false,error:'<unavailable>'},null,logs,zone),/id="start-capture" disabled/);
 assert.match(captureMarkup({ready:false},null,logs,zone),/component 0.8.0/);
 const ready=captureMarkup({ready:true},{active:false,overwritten:0},logs,zone);assert.match(ready,/id="start-capture" >/);assert.match(ready,/id="stop-capture" disabled/);
 const pending=captureMarkup({ready:true,request:{state:'queued',action:'start'}},{active:false,overwritten:0},logs,zone);assert.match(pending,/id="start-capture" disabled/);assert.match(pending,/start queued/);
 const diagnostics=boilerDiagnosticsMarkup({status,checks:[]},{ready:true},logs,'status',zone);assert.match(diagnostics,/Reported health/);assert.doesNotMatch(diagnostics,/id="start-capture"/);
 assert.match(boilerDiagnosticsMarkup({status,checks:[]},{ready:true},logs,'capture',zone),/id="start-capture"/);
});
test('event summaries are escaped and raw telemetry is shown only in diagnostic history',()=>{
 const rows=[{at:status.lastSeen,summary:'<fault>',telemetry:{flow_c:41}}];
 assert.match(boilerEventTable(rows,'Europe/London'),/&lt;fault&gt;/);assert.doesNotMatch(boilerEventTable(rows,'Europe/London'),/Telemetry JSON/);
 assert.match(boilerEventTable(rows,'Europe/London',true),/Telemetry JSON/);
});
