import test from 'node:test';
import assert from 'node:assert/strict';
import {heatingOverview,bindHouseSetpoint} from '../public/heating-overview.js';

function data(target=19){return {plan:{settings:{houseTarget:target,awayTarget:16},profile:{name:'Evening'},occupancy:{effective:'home'}},smartPlan:{kind:'comfort',heat:true,reason:'Office is below target.'},control:{active:false}};}
test('overview has a single setpoint with accessible step controls and distinct planned and actual status',()=>{
 const html=heatingOverview(data(),{connected:true,telemetry:{remote_active:false}});
 assert.match(html,/House setpoint/);assert.match(html,/Increase house setpoint/);assert.match(html,/Decrease house setpoint/);
 assert.match(html,/Heat planned/);assert.match(html,/Local PID/);assert.match(html,/Planning/);
 assert.doesNotMatch(html,/<input|<form|High rooms use|Dallas probe|Planned targets and flow/);
 assert.equal((html.match(/19.0/g)||[]).length,1);
 assert.match(heatingOverview(data(28),{}),/data-setpoint-step="0.5"[^>]*disabled/);
 assert.match(heatingOverview(data(16),{}),/data-setpoint-step="-0.5"[^>]*disabled/);
});

test('setpoint steps save once, preserve schedule settings, respect limits and roll back failures',async t=>{
 const original=globalThis.document;t.after(()=>{globalThis.document=original;});
 const buttons=[.5,-.5].map(step=>({dataset:{setpointStep:String(step)},disabled:false})),display={textContent:'19.0'},status={textContent:''},toast={};
 const root={dataset:{},querySelectorAll:()=>buttons,querySelector:selector=>selector==='#house-target-value'?display:status};
 globalThis.document={querySelector:selector=>selector==='.heating-hero'?root:toast};
 const view={data:data()},ctx={reload:async()=>{}};let release,saves=0;
 bindHouseSetpoint(view,ctx,async(_ctx,plan)=>{saves++;assert.equal(plan.awayTarget,16);await new Promise(resolve=>release=resolve);});
 const pending=buttons[0].onclick();assert.equal(display.textContent,'19.5');assert.ok(buttons.every(b=>b.disabled));
 await buttons[0].onclick();assert.equal(saves,1);release();await pending;assert.equal(view.data.plan.settings.houseTarget,19.5);
 view.data.plan.settings.houseTarget=28;bindHouseSetpoint(view,ctx,async()=>{saves++;});assert.equal(buttons[0].disabled,true);await buttons[0].onclick();assert.equal(saves,1);
 view.data.plan.settings.houseTarget=16;bindHouseSetpoint(view,ctx,async()=>{saves++;});assert.equal(buttons[1].disabled,true);await buttons[1].onclick();assert.equal(saves,1);
 view.data.plan.settings.houseTarget=19;display.textContent='19.0';bindHouseSetpoint(view,ctx,async()=>{throw Error('Save failed');});
 await buttons[1].onclick();assert.equal(display.textContent,'19.0');assert.equal(view.data.plan.settings.houseTarget,19);assert.equal(status.textContent,'Not saved');
 clearTimeout((await import('../public/ui.js')).toast.timer);
});
