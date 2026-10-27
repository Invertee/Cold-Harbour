import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../public/ui.js';
import {modules} from '../public/modules/registry.js';

function client(t,fetcher){
 const original={fetch:globalThis.fetch,location:globalThis.location};
 globalThis.location={href:'https://home.test/api/hassio_ingress/session/'};
 globalThis.fetch=fetcher;
 t.after(()=>{for(const [key,value] of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});

test('reads recover from a plain-text gateway error and retain the Home Assistant ingress URL',async t=>{
 let calls=0;
 client(t,async(url,options)=>{
  assert.equal(url.href,'https://home.test/api/hassio_ingress/session/api/heating');assert.ok(options.signal);assert.equal(options.headers['X-MODS-Request'],'1');
  return ++calls===1?new Response('502: Bad Gateway',{status:502}):json({rooms:[]});
 });
 assert.deepEqual(await api('heating'),{rooms:[]});assert.equal(calls,2);
});

test('persistent malformed, empty and HTML responses produce a friendly error with a bounded retry',async t=>{
 client(t,async()=>{});
 for(const [body,status] of [['502: Bad Gateway',502],['<html>Unavailable</html>',200],['',200],['null',200]]){
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response(body,{status});};
  await assert.rejects(api('heating'),error=>!(error instanceof SyntaxError)&&/temporarily unavailable/.test(error.message)&&(!body||!error.message.includes(body)));assert.equal(calls,2);
 }
});

test('access and application validation errors retain useful messages and are not retried',async t=>{
 client(t,async()=>{});
 for(const [response,message] of [[new Response('401: Unauthorized',{status:401}),/Reopen it from Home Assistant/],[json({error:'Choose a valid period.'},400),/Choose a valid period/]]){
  let calls=0;globalThis.fetch=async()=>{calls++;return response;};
  await assert.rejects(api('settings'),message);assert.equal(calls,1);
 }
});

test('network failures retry reads but never repeat changes with an uncertain result',async t=>{
 let calls=0;client(t,async()=>{calls++;throw new TypeError('Failed to fetch');});
 await assert.rejects(api('heating'),/Connection interrupted/);assert.equal(calls,2);
 calls=0;await assert.rejects(api('heating/setpoint',{method:'POST',body:'{"target":21}'}),/Check whether your change was saved/);assert.equal(calls,1);
 calls=0;globalThis.fetch=async()=>{calls++;return new Response('502: Bad Gateway',{status:502});};
 await assert.rejects(api('settings',{method:'POST',body:'{}'}),/temporarily unavailable/);assert.equal(calls,1);
});

test('body-read failures recover and caller cancellation is not retried',async t=>{
 let calls=0;client(t,async()=>++calls===1?{ok:true,status:200,json:async()=>{throw new TypeError('Connection closed');}}:json({ok:true}));
 assert.deepEqual(await api('heating'),{ok:true});assert.equal(calls,2);
 const controller=new AbortController();calls=0;globalThis.fetch=async()=>{calls++;controller.abort();throw new DOMException('Aborted','AbortError');};
 await assert.rejects(api('heating',{signal:controller.signal}),/Request cancelled/);assert.equal(calls,1);
});

test('requests have a timeout and stalled changes are never submitted again',async t=>{
 let calls=0;client(t,async(_url,{signal})=>{calls++;assert.ok(signal.aborted);throw signal.reason;});
 t.mock.method(AbortSignal,'timeout',milliseconds=>{assert.equal(milliseconds,20000);return AbortSignal.abort(new DOMException('Timed out','TimeoutError'));});
 await assert.rejects(api('heating'),/Connection interrupted/);assert.equal(calls,2);
 calls=0;await assert.rejects(api('heating/setpoint',{method:'POST',body:'{"target":21}'}),/Check whether your change was saved/);assert.equal(calls,1);
});

test('page refresh failures preserve readings, mark them stale, recover and keep navigation errors on the correct page',async t=>{
 const globals=['document','window','location','history','setInterval','fetch'];
 const originals=Object.fromEntries(globals.map(key=>[key,globalThis[key]]));
 const originalModules=modules.map(module=>({module,render:module.render,bind:module.bind}));
 t.after(()=>{for(const [key,value] of Object.entries(originals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}for(const item of originalModules){item.module.render=item.render;item.module.bind=item.bind;}});
 const element=()=>({innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}},addEventListener(){},focus(){},scrollIntoView(){}});
 const selectors=['#main','#navigation','#refresh','#breadcrumb-current','#system-status','#mode-pill','#today','#editor','.skip-link','#connection-notice','#retry'];
 const elements=Object.fromEntries(selectors.map(selector=>[selector,element()]));elements['#connection-notice'].hidden=true;
 globalThis.document={querySelector:selector=>elements[selector] || null,querySelectorAll:()=>[],hidden:false,activeElement:null};
 globalThis.window={addEventListener(){},scrollTo(){}};globalThis.location={href:'http://test.local/',hash:'#heating'};globalThis.history={replaceState(){}};
 let poll;globalThis.setInterval=callback=>{poll=callback;return 1;};
 globalThis.fetch=async()=>json({thermostat:{mode:'active'},general:{timezone:'Europe/London'}});
 let fail=false,reading=19,release;
 for(const module of modules){module.render=async()=>{if(fail)throw new Error('Cold Harbour is temporarily unavailable. Please try again.');return `Readings: ${reading}`;};module.bind=()=>{};}
 const {render}=await import('../public/app.js?recovery-test');await new Promise(resolve=>setImmediate(resolve));
 const main=elements['#main'],notice=elements['#connection-notice'],first=main.innerHTML;assert.match(first,/Readings: 19/);
 fail=true;await render({background:true});assert.equal(main.innerHTML,first);assert.equal(notice.hidden,false);assert.match(notice.innerHTML,/may be out of date/);assert.equal(elements['#system-status'].textContent,'Connection interrupted');
 fail=false;reading=20;globalThis.document.activeElement={tagName:'BUTTON',id:'retry'};poll();await new Promise(resolve=>setImmediate(resolve));assert.match(main.innerHTML,/Readings: 20/);assert.equal(notice.hidden,true);globalThis.document.activeElement=null;
 // A slow refresh must finish before the next automatic refresh can begin.
 const heating=modules.find(module=>module.id==='heating');let renders=0;
 heating.render=async()=>{renders++;await new Promise(resolve=>release=resolve);return 'Recovered readings';};
 const pending=render({background:true});await new Promise(resolve=>setImmediate(resolve));await render({background:true});assert.equal(renders,1);release();await pending;
 // Initial navigation failures must not show the previous page as current data.
 fail=true;globalThis.location.hash='#settings';await render();assert.match(main.innerHTML,/Unable to load data/);assert.doesNotMatch(main.innerHTML,/Recovered readings/);assert.equal(notice.hidden,true);
 // Settings also recover automatically after an error, despite normally pausing refresh.
 fail=false;poll();await new Promise(resolve=>setImmediate(resolve));assert.match(main.innerHTML,/Readings: 20/);
 fail=true;await render({background:true});assert.equal(notice.hidden,false);fail=false;reading=21;poll();await new Promise(resolve=>setImmediate(resolve));assert.match(main.innerHTML,/Readings: 21/);assert.equal(notice.hidden,true);
});
