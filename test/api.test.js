import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join,resolve,basename,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/app.js';

function removeFixture(directory){const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&/^mods-(api|ingress)-/.test(basename(target)));rmSync(target,{recursive:true,force:true});}

test('HTTP API supports durable room edits, protects writes and keeps secrets server-side',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mods-api-'));
  const app=createApplication({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();removeFixture(dir);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-MODS-Request':'1',...headers},body:body?JSON.stringify(body):undefined});
  let response=await request('/api/settings',{section:'homeAssistant',values:{token:'private-key',url:'http://ha.test'}});assert.equal(response.status,200);assert.equal((await response.json()).secrets.haToken,true);
  const config=await (await request('/api/settings')).text();assert.ok(!config.includes('private-key'));
  response=await request('/api/rooms',{name:'Nursery',sensorEntity:'sensor.nursery',comfort:20,eco:17,weight:1.2,icon:'bed'});assert.equal(response.status,200);const room=await response.json();assert.ok(room.id);assert.ok((await (await request('/api/rooms')).json()).some(r=>r.name==='Nursery'));
  response=await request('/api/settings',{section:'heating',values:{enabled:true}});assert.equal(response.status,400);
  response=await request('/api/settings',{section:'general',values:{timezone:'Neverland/Clock'}});assert.equal(response.status,400);
  response=await request('/api/settings',{section:'__proto__',values:{mode:'listen'}});assert.equal(response.status,400);
  response=await request('/api/settings',{section:'general',values:{constructor:'invalid'}});assert.equal(response.status,400);
  response=await request('/api/settings',{section:'general',values:{mode:'listen'}},{'X-MODS-Request':'0'});assert.equal(response.status,403);
  response=await request('/api/rules',{name:'Invalid',roomId:'none',target:20,priority:2,activity:'home',days:[1],start:'25:00',end:'07:00',enabled:true});assert.equal(response.status,400);
  response=await request('/api/energy');assert.equal(response.status,200);assert.equal((await response.json()).energySource,'homeAssistant');
  response=await request('/api/settings',{section:'general',values:{mode:'listen'}});assert.equal(response.status,200);assert.equal((await (await request('/api/energy')).json()).energySource,'homeAssistant');
  response=await fetch(base+'/');assert.equal(response.status,200);assert.match(await response.text(),/Cold Harbour/);
  response=await fetch(base+'/api/settings', {headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(response.status,403);
});
test('HA ingress rejects connections that bypass its proxy',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mods-ingress-'));const app=createApplication({dataDir:dir,ingressOnly:true});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();removeFixture(dir);});const base=`http://127.0.0.1:${app.server.address().port}`;assert.equal((await fetch(base+'/api/settings')).status,403);assert.equal((await fetch(base+'/health')).status,200);
});

test('room API saves ZHA and device mappings and prevents conflicting radiator assignments',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mods-api-'));const app=createApplication({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await app.close();removeFixture(dir);});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-MODS-Request':'1'},body:JSON.stringify(body)});
  const input={name:'Kitchen trial',sensorEntities:['sensor.kitchen'],radiatorEntity:'climate.kitchen_trv',comfort:20,eco:16,weight:1,presenceMode:'comfort',presenceHoldMinutes:20,presenceRules:[{entityId:'switch.kitchen_device',condition:'is',value:'on'}]};
  let response=await post('/api/rooms',input);assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.radiatorEntity,input.radiatorEntity);assert.deepEqual(saved.presenceRules,input.presenceRules);
  response=await post('/api/rooms',{...input,name:'Other room'});assert.equal(response.status,400);
  response=await post('/api/rooms',{...input,id:saved.id,name:'Kitchen updated'});assert.equal(response.status,200);
  response=await post('/api/settings',{section:'homeAssistant',values:{climateEntity:input.radiatorEntity}});assert.equal(response.status,400);
  response=await post('/api/settings',{section:'homeAssistant',values:{climateEntity:'climate.boiler'}});assert.equal(response.status,400);
  response=await post('/api/rooms',{...input,id:saved.id,radiatorEntity:'climate.boiler'});assert.equal(response.status,200);
  const heating=await (await fetch(base+'/api/heating')).json();assert.equal(heating.valveControlEnabled,false);assert.equal(heating.controlStrategy,'scheduled-priority');assert.equal(heating.mode,'listen');
});
