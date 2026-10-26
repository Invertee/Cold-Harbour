import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../server/db.js';
import {createHomeAssistant,connection} from '../server/integrations/home-assistant.js';
import {readEntityRegistry,isCaptureEntry} from '../server/integrations/ha-registry.js';
const entry={entity_id:'switch.renamed_capture',platform:'esphome',original_name:'OpenTherm Message Capture',unique_id:'mac-switch-hash',disabled_by:null};
function fixture(t,entries=[entry]){
 const dir=mkdtempSync(join(tmpdir(),'cold-capture-')),store=createStore(dir),requests=[];store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test-token');
 const states=entries.map(e=>({entity_id:e.entity_id,state:'off',attributes:{friendly_name:'Boiler capture'}}));
 const ha=createHomeAssistant(store,async(url,options)=>{requests.push({url,options});return url.endsWith('/states')?states:[];},async()=>entries);
 t.after(()=>{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('cold-capture-'));rmSync(dir,{recursive:true,force:true});});return {store,requests,ha,states};
}
test('capture discovery handles renamed entities and only controls the verified diagnostic switch',async t=>{
 const f=fixture(t);await f.ha.poll();assert.equal(f.ha.captureStatus().automatic,true);await f.ha.setMessageCapture(true);
 assert.equal(f.requests[1].url,'http://ha.test/api/services/switch/turn_on');assert.deepEqual(JSON.parse(f.requests[1].options.body),{entity_id:entry.entity_id});
 f.store.save('homeAssistant',{...f.store.config().homeAssistant,captureEntity:'switch.comfort_heating_enabled'});await assert.rejects(()=>f.ha.setMessageCapture(false),e=>e.status===409);assert.equal(f.requests.length,2);
 assert.equal(isCaptureEntry({...entry,platform:'template'}),false);assert.equal(isCaptureEntry({...entry,original_name:'Comfort Heating Enabled'}),false);
});
test('ambiguous, disabled, stale and unavailable capture mappings never issue service calls',async t=>{
 const f=fixture(t,[entry,{...entry,entity_id:'switch.other_capture'}]);await f.ha.poll();assert.equal(f.ha.captureStatus().ready,false);await assert.rejects(()=>f.ha.setMessageCapture(true));
 f.store.save('homeAssistant',{...f.store.config().homeAssistant,captureEntity:entry.entity_id});assert.equal(f.ha.captureStatus().ready,true);assert.equal(f.ha.captureStatus(Date.now()+46000).ready,false);
 f.states[0].state='unavailable';await assert.rejects(()=>f.ha.setMessageCapture(true));f.ha.invalidate();await assert.rejects(()=>f.ha.setMessageCapture(false));assert.equal(f.requests.length,1);
 const disabled=fixture(t,[{...entry,disabled_by:'user'}]);await disabled.ha.poll();assert.equal(disabled.ha.captureStatus().ready,false);
});
test('Supervisor connection is automatic and does not require a stored user token',t=>{
 const f=fixture(t),previous=process.env.SUPERVISOR_TOKEN;try{process.env.SUPERVISOR_TOKEN='supervisor-test';assert.deepEqual(connection(f.store),{url:'http://supervisor/core',token:'supervisor-test'});}finally{if(previous===undefined)delete process.env.SUPERVISOR_TOKEN;else process.env.SUPERVISOR_TOKEN=previous;}
});
test('registry WebSocket authenticates and only sends the read-only entity list command',async()=>{
 const sent=[];
 class FakeSocket{
  listeners={};constructor(url){assert.equal(String(url),'ws://ha.test/api/websocket');queueMicrotask(()=>this.emit({type:'auth_required'}));}
  addEventListener(name,fn){this.listeners[name]=fn;}close(){}
  emit(value){this.listeners.message({data:JSON.stringify(value)});}
  send(value){const m=JSON.parse(value);sent.push(m);queueMicrotask(()=>this.emit(m.type==='auth'?{type:'auth_ok'}:{id:1,type:'result',success:true,result:[entry]}));}
 }
 assert.deepEqual(await readEntityRegistry('http://ha.test','secret-token',FakeSocket),[entry]);assert.deepEqual(sent,[{type:'auth',access_token:'secret-token'},{id:1,type:'config/entity_registry/list'}]);
 class ProxySocket extends FakeSocket{constructor(url){assert.equal(String(url),'ws://supervisor/core/websocket');super('ws://ha.test/api/websocket');}}
 assert.deepEqual(await readEntityRegistry('http://supervisor/core','supervisor-token',ProxySocket),[entry]);
});
