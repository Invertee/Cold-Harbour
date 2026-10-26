import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,basename,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRoom } from '../server/validate.js';
import { createStore } from '../server/db.js';

const input=()=>({name:'Kitchen',sensorEntities:['sensor.kitchen'],radiatorEntity:'climate.kitchen_trv',comfort:20,eco:16,weight:1,presenceMode:'comfort',presenceHoldMinutes:20,presenceRules:[{entityId:'media_player.kitchen',condition:'is',value:'playing'},{entityId:'sensor.kitchen_power',condition:'above',value:40}]});
function cleanup(dir) { const target=resolve(dir);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&/^cold-rooms-/.test(basename(target)));rmSync(target,{recursive:true,force:true}); }

test('room mappings persist and old single-temperature records remain supported',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cold-rooms-'));
  let store=createStore(dir);
  try {
    const saved=store.put('rooms',validateRoom({...input(),sensorFreshnessMinutes:120}));
    assert.equal(saved.sensorFreshnessMinutes,120);
    const legacy=validateRoom({name:'Office',sensorEntity:'sensor.office',occupancyEntity:'binary_sensor.office',comfort:21,eco:16,weight:1});
    assert.deepEqual(legacy.sensorEntities,['sensor.office']);assert.equal(legacy.presenceMode,'priority');assert.equal(legacy.occupancyEntity,'binary_sensor.office');
    store.close();store=createStore(dir);
    assert.deepEqual(store.list('rooms').find(room=>room.id===saved.id),saved);
  } finally {store.close();cleanup(dir);}
});

test('invalid room clues, thresholds and valve domains are rejected',()=>{
  for (const changes of [
    {radiatorEntity:'switch.boiler'}, {presenceMode:'guess'}, {presenceHoldMinutes:-1}, {presenceRules:{}}, {sensorEntities:'sensor.kitchen'},
    {sensorFreshnessMinutes:0},{sensorFreshnessMinutes:1441},{sensorFreshnessMinutes:'120'},
    {presenceRules:[{entityId:'climate.boiler',condition:'is',value:'heat'}]},
    {presenceRules:[{entityId:'switch.pc',condition:'above',value:10}]},
    {presenceRules:[{entityId:'sensor.pc',condition:'above',value:'40'}]},
    {presenceRules:[{entityId:'switch.pc',condition:'is',value:'unavailable'}]},
    {presenceRules:Array.from({length:13},()=>({entityId:'switch.pc',condition:'is',value:'on'}))},
  ]) assert.throws(()=>validateRoom({...input(),...changes}),error=>error.status===400);
});

test('listener migration removes legacy control and Octopus credentials while retaining mappings',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cold-rooms-'));let store=createStore(dir);
  try {
    const saved=store.put('rooms',validateRoom(input()));store.secret('haToken','ha-kept');store.secret('boilerKey','pairing-kept');store.secret('octopusKey','removed');
    store.save('heating',{...store.config().heating,enabled:true,controlTarget:'thermostat'});store.save('general',{demo:true,timezone:'Europe/London'});store.save('homeAssistant',{url:'http://ha.test',powerEntity:'sensor.power',climateEntity:'climate.boiler'});store.save('energy',{...store.config().energy,source:'octopus',electricityMeter:'my-meter'});store.save('octopus',{accountNumber:'A-123',deviceId:'old'});
    store.db.prepare('DELETE FROM migrations WHERE version=6').run();store.db.exec('DROP TABLE boiler_exchanges;DROP TABLE boiler_frames;');store.close();store=createStore(dir);
    assert.deepEqual(store.config().heating,{activity:'auto',staleMinutes:30});assert.equal(store.config().general.mode,'listen');assert.equal(store.config().general.demo,undefined);assert.equal(store.config().homeAssistant.climateEntity,undefined);assert.equal(store.config().energy.source,undefined);assert.equal(store.config().energy.electricityMeter,'my-meter');assert.equal(store.config().octopus,undefined);assert.equal(store.secret('octopusKey'),'');assert.equal(store.secret('haToken'),'ha-kept');assert.equal(store.secret('boilerKey'),'pairing-kept');assert.ok(store.list('rooms').some(room=>room.id===saved.id));
  } finally {store.close();cleanup(dir);}
});
