import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createApplication} from '../server/app.js';
import {createNotificationActions} from '../server/integrations/notification-actions.js';
import {defaults} from '../server/defaults.js';
import {validateConfig} from '../server/validate.js';
import {validateBackupData} from '../server/backups.js';
import {heatingSummary} from '../server/modules/heating.js';
import {gasBudgetMarkup} from '../public/modules/gas-budget.js';
import {notificationContent} from '../public/modules/notifications.js';

const phone='service:notify.mobile_app_phone',other='service:notify.mobile_app_other';
const services=[{domain:'notify',services:{mobile_app_phone:{name:'Sam’s phone'},mobile_app_other:{name:'Other phone'}}}];
class PhoneSocket extends EventTarget{
 static instances=[];
 constructor(url){super();this.url=String(url);this.sent=[];this.closed=false;PhoneSocket.instances.push(this);queueMicrotask(()=>this.message({type:'auth_required'}));}
 message(value){if(!this.closed)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
 send(raw){const value=JSON.parse(raw);this.sent.push(value);queueMicrotask(()=>this.message(value.type==='auth'?{type:'auth_ok'}:value.type==='ping'?{type:'pong',id:2}:{type:'result',id:1,success:true}));}
 close(){if(this.closed)return;this.closed=true;this.dispatchEvent(new Event('close'));}
 action(action){this.message({type:'event',id:1,event:{event_type:'mobile_app_notification_action',data:{action}}});}
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{pauseAction=true,targets=[phone],Socket=PhoneSocket}={}){
 let now=Date.parse('2026-11-06T12:00:00Z'),usage=44,cost=4.4,failTarget='',states=[],app;
 t.mock.method(Date,'now',()=>now);
 const directory=mkdtempSync(join(tmpdir(),'cold-budget-alert-')),writes=[];
 const request=async(url,options)=>{
  if(options?.method==='POST'){
   writes.push({url,body:JSON.parse(options.body)});
   if(failTarget&&url.endsWith(failTarget))throw new Error('provider unavailable');return [];
  }
  return url.endsWith('/api/services')?services:states;
 };
 const open=()=>{
  const instance=createApplication({dataDir:directory,haRequest:request,haRegistryRequest:async()=>[],haActionSocket:Socket});
  t.mock.getter(instance.context.ha,'status',()=>({connected:true,fetchedAt:new Date(now).toISOString(),configured:true}));
  return instance;
 };
 app=open();
 const config=app.context.store.config();
 app.context.store.save('homeAssistant',{...config.homeAssistant,url:'http://ha.test'});app.context.store.secret('haToken','private-test-token');
 app.context.store.save('energy',{...config.energy,gasToday:'sensor.gas_today',gasTodayCost:'sensor.gas_cost'});
 app.context.store.save('gasBudget',{...config.gasBudget,enabled:true,action:'monitor'});
 app.context.store.save('notifications',{enabled:true,targets:[other],gasBudget:{enabled:true,thresholdPercent:90,targets,pauseAction}});
 const refresh=async()=>{
  const at=new Date(now).toISOString();
  states=[{entity_id:'sensor.gas_today',state:String(usage),last_updated:at,last_reported:at,attributes:{unit_of_measurement:'kWh'}},{entity_id:'sensor.gas_cost',state:String(cost),last_updated:at,last_reported:at,attributes:{unit_of_measurement:'GBP'}},{entity_id:'sensor.room',state:'18',last_updated:at,last_reported:at,attributes:{unit_of_measurement:'°C'}}];
  await app.context.ha.poll();
 };
 const check=async()=>{await app.context.gasBudgetNotifications.check(now);await flush();await app.context.gasBudgetNotifications.check(now);};
 t.after(async()=>{await app.close();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith('cold-budget-alert-'));rmSync(target,{recursive:true,force:true});});
 await refresh();
 return {get app(){return app;},get store(){return app.context.store;},writes,get now(){return now;},setNow(value){now=value;},setUsage(value){usage=value;},setCost(value){cost=value;},fail(value){failTarget=value;},refresh,check,
  async restart(){await app.close();app=open();await refresh();},
  action(){return writes.at(-1)?.body.data?.actions[0].action;},
 };
}

test('fresh budget threshold sends only to selected phones once, with an actionable payload; restart keeps deduplication',async t=>{
 const f=await fixture(t);await f.check();assert.equal(f.writes.length,0);
 f.setUsage(45);await f.refresh();await f.check();assert.equal(f.writes.length,1);
 assert.match(f.writes[0].url,/mobile_app_phone$/);assert.match(f.writes[0].body.message,/45.0 kWh of 50.0 kWh/);
 assert.equal(f.writes[0].body.data.actions[0].title,'Pause heating today');assert.equal(f.writes[0].body.data.actions[0].authenticationRequired,true);
 assert.match(f.action(),/^COLD_HARBOUR_PAUSE_/);assert.equal(f.app.context.gasBudgetNotifications.status().ready,true);
 await f.check();await f.restart();await f.check();assert.equal(f.writes.length,1);
 f.setNow(Date.parse('2026-11-07T12:00:00Z'));await f.refresh();await f.check();assert.equal(f.writes.length,2);
});

test('phone button pauses through existing heating controls, survives restart, preserves frost, and resume invalidates old buttons',async t=>{
 const f=await fixture(t);f.setUsage(46);await f.refresh();await f.check();const action=f.action();
 assert.equal(f.app.context.gasBudgetNotifications.handleAction({event_type:'mobile_app_notification_action',data:{action:'forged'}}),false);
 PhoneSocket.instances.at(-1).action(action);await flush();assert.equal(f.app.context.gasBudget.status().manualPause,true);
 assert.equal(f.app.context.gasBudget.status().settings.action,'monitor');
 const room=f.store.list('rooms')[0];f.store.put('rooms',{...room,sensorEntity:'sensor.room',sensorEntities:['sensor.room']});
 let summary=heatingSummary(f.app.context);assert.equal(summary.smartPlan.kind,'budget');assert.equal(summary.smartPlan.heat,false);
 assert.equal(f.store.config().thermostat.mode,'planning'); // The action never enables control.
 await f.restart();assert.equal(f.app.context.gasBudget.status().paused,true);
 const cold=f.app.context.ha.states.find(s=>s.entity_id==='sensor.room');cold.state='5';
 summary=heatingSummary(f.app.context);assert.equal(summary.smartPlan.kind,'frost');assert.equal(summary.budget.frostOverride,true);
 f.app.context.gasBudget.resume();assert.equal(f.app.context.gasBudget.status().paused,false);
 assert.equal(f.app.context.gasBudgetNotifications.handleAction({event_type:'mobile_app_notification_action',data:{action}}),false);
 await f.check();assert.equal(f.writes.length,1);
 f.app.context.gasBudget.pause();f.setNow(Date.parse('2026-11-07T00:01:00Z'));f.setUsage(0);await f.refresh();assert.equal(f.app.context.gasBudget.status().paused,false);
});

test('disabled, stale or missing readings never warn; delayed readings beyond the cap and cost budgets do warn',async t=>{
 const f=await fixture(t,{pauseAction:false});f.setUsage(55);await f.refresh();
 f.setNow(f.now+91*60000);await f.check();assert.equal(f.writes.length,0);
 await f.refresh();f.app.context.ha.states.find(s=>s.entity_id==='sensor.gas_today').state='unavailable';await f.check();assert.equal(f.writes.length,0);
 await f.refresh();f.store.save('notifications',{...f.store.config().notifications,enabled:false});await f.check();assert.equal(f.writes.length,0);
 f.store.save('notifications',{...f.store.config().notifications,enabled:true});await f.check();assert.equal(f.writes.length,1);assert.match(f.writes[0].body.title,/reached/);assert.equal(f.writes[0].body.data,undefined);
 f.store.save('gasBudget',{...f.store.config().gasBudget,unit:'cost',dailyLimit:5});f.setCost(4.5);await f.refresh();await f.check();assert.equal(f.writes.length,2);assert.match(f.writes[1].body.message,/£4.50 of £5.00/);
});

test('partial delivery retries failed phones after five minutes without repeating accepted phones',async t=>{
 const f=await fixture(t,{targets:[phone,other],pauseAction:false});f.setUsage(46);await f.refresh();f.fail('/mobile_app_other');await f.check();assert.equal(f.writes.length,2);
 await f.check();assert.equal(f.writes.length,2);f.fail('');f.setNow(f.now+5*60000);await f.refresh();await f.check();assert.equal(f.writes.length,3);assert.match(f.writes[2].url,/mobile_app_other$/);
});

test('budget warning still sends without a button when HA event subscription is denied',async t=>{
 class DeniedSocket extends PhoneSocket{
  send(raw){const value=JSON.parse(raw);this.sent.push(value);queueMicrotask(()=>this.message(value.type==='auth'?{type:'auth_ok'}:{type:'result',id:1,success:false}));}
 }
 const f=await fixture(t,{Socket:DeniedSocket});f.setUsage(46);await f.refresh();await f.check();
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.data,undefined);assert.match(f.writes[0].body.message,/Phone action unavailable/);
 assert.equal(f.app.context.gasBudgetNotifications.status().ready,false);assert.match(f.app.context.gasBudgetNotifications.status().error,/permissions/);
});

test('actions expire or become invalid after recipient, credential, budget or enable changes',async t=>{
 const f=await fixture(t);f.setUsage(46);await f.refresh();await f.check();const action=f.action(),event={event_type:'mobile_app_notification_action',data:{action}};
 const notifications=f.store.config().notifications;
 f.store.save('notifications',{...notifications,enabled:false});assert.equal(f.app.context.gasBudgetNotifications.handleAction(event),false);
 f.store.save('notifications',{...notifications,gasBudget:{...notifications.gasBudget,targets:[other]}});assert.equal(f.app.context.gasBudgetNotifications.handleAction(event),false);
 f.store.save('notifications',notifications);f.store.secret('haToken','new-token');assert.equal(f.app.context.gasBudgetNotifications.handleAction(event),false);f.store.secret('haToken','private-test-token');
 const budget=f.store.config().gasBudget;f.store.save('gasBudget',{...budget,dailyLimit:60});assert.equal(f.app.context.gasBudgetNotifications.handleAction(event),false);f.store.save('gasBudget',budget);
 f.setNow(Date.parse('2026-11-07T00:01:00Z'));await f.refresh();assert.equal(f.app.context.gasBudgetNotifications.handleAction(event),false);
});

test('pause API protects writes, supports resume and leaves automatic caps in force',async t=>{
 const f=await fixture(t,{pauseAction:false});await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${f.app.server.address().port}/api/energy/gas-budget/pause`;
 const post=(body,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await post({paused:true})).status,403);
 const headers={'X-MODS-Request':'1'};assert.equal((await post({paused:'true'},headers)).status,400);
 let response=await post({paused:true},headers);assert.equal(response.status,200);assert.equal((await response.json()).manualPause,true);
 f.setUsage(55);await f.refresh();f.store.save('gasBudget',{...f.store.config().gasBudget,action:'pause'});
 response=await post({paused:false},headers);const status=await response.json();assert.equal(status.manualPause,false);assert.equal(status.paused,true);
});

test('warning settings validate phone targets and thresholds and migrate older notification backups',async t=>{
 const initial=defaults.notifications;
 const valid={enabled:true,targets:[],gasBudget:{enabled:true,thresholdPercent:85,targets:[phone],pauseAction:true}};
 assert.deepEqual(validateConfig('notifications',valid,initial),valid);
 for(const change of [{thresholdPercent:0},{thresholdPercent:101},{thresholdPercent:'90'},{targets:[]},{targets:['entity:notify.display']},{targets:[phone,phone]},{pauseAction:'yes'},{other:true}])assert.throws(()=>validateConfig('notifications',{...valid,gasBudget:{...valid.gasBudget,...change}},initial),e=>e.status===400);
 const f=await fixture(t),config=f.store.config();config.notifications={enabled:true,targets:[phone]};
 const restored=validateBackupData({appVersion:'0.17.0',exportedAt:new Date(f.now).toISOString(),config,rooms:f.store.list('rooms'),rules:f.store.list('rules'),secrets:{haToken:'',boilerKey:''}});
 assert.deepEqual(restored.config.notifications.gasBudget,initial.gasBudget);
 const html=notificationContent(valid,{targets:[],actions:{ready:false,error:'<script>bad</script>'}});
 assert.match(html,/name="budgetTargets"[^>]*checked/);assert.match(html,/Gas budget warnings/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 f.app.context.gasBudget.pause();assert.match(gasBudgetMarkup(f.app.context.gasBudget.chart(),false),/Resume heating/);
});

test('event subscription authenticates, reconnects, pings, rejects stale connections and closes cleanly',async()=>{
 let config={url:'http://ha.test',token:'secret',generation:0,enabled:true},received=0;
 const actions=createNotificationActions({Socket:PhoneSocket,source:()=>config,onAction:()=>{received++;}});
 const now=Date.now();actions.sync(now);await flush();const socket=PhoneSocket.instances.at(-1);
 assert.equal(actions.status().ready,true);assert.deepEqual(socket.sent[1],{id:1,type:'subscribe_events',event_type:'mobile_app_notification_action'});
 actions.sync(now+31000);await flush();assert.equal(socket.sent.at(-1).type,'ping');
 socket.action('test');await flush();assert.equal(received,1);
 socket.close();assert.equal(actions.status().ready,false);actions.sync(now+32000);await flush();assert.equal(actions.status().ready,true);
 const replacement=PhoneSocket.instances.at(-1);config={...config,token:'changed',generation:1};replacement.action('test');await flush();assert.equal(received,1);assert.equal(replacement.closed,true);
 actions.sync(now+33000);await flush();assert.equal(actions.status().ready,true);actions.close();assert.equal(PhoneSocket.instances.at(-1).closed,true);
});
