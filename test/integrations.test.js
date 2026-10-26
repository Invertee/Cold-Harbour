import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,basename,sep } from 'node:path';
import { createStore } from '../server/db.js';
import { createHomeAssistant } from '../server/integrations/home-assistant.js';
import { energySummary,powerReading } from '../server/modules/energy.js';

function removeFixture(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&/^mods-(test|restart)-/.test(basename(target)));rmSync(target,{recursive:true,force:true});}
function storeFixture(t){const directory=mkdtempSync(join(tmpdir(),'mods-test-'));const store=createStore(directory);t.after(()=>{store.close();removeFixture(directory);});return store;}
test('SQLite settings and encrypted credentials persist together',t=>{
  const store=storeFixture(t);store.secret('haToken','private-secret');assert.equal(store.secret('haToken'),'private-secret');assert.ok(!store.db.prepare('SELECT value FROM secrets').get().value.includes('private-secret'));store.secret('haToken','');assert.equal(store.secret('haToken'),'');store.put('rooms',{id:'custom',name:'Test'});assert.ok(store.list('rooms').some(r=>r.id==='custom'));
});
test('editing rooms preserves their display order',t=>{
  const store=storeFixture(t),before=store.list('rooms').map(room=>room.id);store.put('rooms',{...store.list('rooms')[0],comfort:21.5});assert.deepEqual(store.list('rooms').map(room=>room.id),before);
});
test('database and credentials can be reopened after a restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mods-restart-'));let store=createStore(directory);
  try{store.secret('haToken','persisted-secret');store.save('general',{mode:'listen',timezone:'Europe/London'});store.close();store=createStore(directory);assert.equal(store.secret('haToken'),'persisted-secret');assert.equal(store.config().general.mode,'listen');assert.equal(store.list('rooms').length,4);}finally{store.close();removeFixture(directory);}
});
test('Home Assistant connection only reads states and exposes no command method',async t=>{
  const store=storeFixture(t);store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test:8123'});store.secret('haToken','token');const requests=[];
  const ha=createHomeAssistant(store,async(url,options)=>{requests.push({url,options});return [{entity_id:'sensor.temp',state:'20'}];},async()=>[]);await ha.poll();assert.equal(ha.status.connected,true);assert.equal(ha.setTemperature,undefined);assert.equal(requests.length,1);assert.match(requests[0].url,/\/api\/states$/);assert.equal(requests[0].options.method,undefined);ha.invalidate();assert.equal(ha.states.length,0);
});

test('old HA requests cannot repopulate states after connection changes',async t=>{
  const store=storeFixture(t);store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','token');let finish;const ha=createHomeAssistant(store,()=>new Promise(resolve=>finish=resolve),async()=>[]);const pending=ha.poll();ha.invalidate();finish([{entity_id:'sensor.old'}]);await pending;assert.equal(ha.states.length,0);assert.equal(ha.status.connected,false);
});
test('power values honour units and reject unavailable values',()=>{const entity={state:'1.25',attributes:{unit_of_measurement:'kW'},last_reported:new Date().toISOString()};assert.equal(powerReading(entity).watts,1250);assert.equal(powerReading({...entity,state:'unavailable'}),null);assert.equal(powerReading({...entity,attributes:{unit_of_measurement:'kWh'}}),null);});
test('live view stays empty without real data and never falls back to demo',t=>{
  const store=storeFixture(t);const data=energySummary({store,ha:{status:{}},octopus:{status:{}}});assert.equal(data.energySource,'homeAssistant');assert.equal(data.live,null);assert.equal(data.kwh,null);assert.equal(data.cost,null);assert.deepEqual(data.rows,[]);
});
