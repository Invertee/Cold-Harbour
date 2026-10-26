import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createWeatherForecasts,normaliseForecast} from '../server/integrations/weather-forecasts.js';
import {createApplication} from '../server/app.js';
import {signedMessage} from '../server/modules/boiler.js';
const now=Date.parse('2026-10-23T05:00:00Z');
const response=(entityId,rows)=>({changed_states:[],service_response:{[entityId]:{forecast:rows}}});
const row=(hours,temperature=10,other={})=>({datetime:new Date(now+hours*3600000).toISOString(),temperature,...other});
const source=()=>({url:'http://ha.test',token:'private-token',entityId:'weather.home',unit:'°C',generation:1,enabled:true,connected:true});

test('forecast normalisation reads response data, converts units, sorts/deduplicates and preserves daily low/high semantics',()=>{
 const data=response('weather.home',[row(2,50),row(0,32),row(2,53.6),row(1,41)]),result=normaliseForecast(data,'weather.home','hourly','°F',now);assert.deepEqual(result.map(p=>p.temperatureC),[0,5,12]);assert.equal(result[0].lowC,null);
 const daily=normaliseForecast(response('weather.home',[row(0,59,{templow:41})]),'weather.home','daily','°F',now)[0];assert.equal(daily.temperatureC,15);assert.equal(daily.lowC,5);
});
test('forecast validation rejects bad units, missing response, invalid temperatures, ambiguous timestamps and excessive horizons',()=>{
 assert.throws(()=>normaliseForecast({},'weather.home','hourly','°C',now));
 const invalid=[row(1,null),row(1,false),row(1,NaN),row(1,100),row(1,10,{templow:20}),row(-4),row(250),{datetime:'2026-10-23T07:00:00',temperature:10}];assert.equal(normaliseForecast(response('weather.home',invalid),'weather.home','hourly','°C',now).length,0);assert.equal(normaliseForecast(response('weather.home',[row(1)]),'weather.home','hourly','K',now).length,0);
 const many=Array.from({length:400},(_,i)=>row(i));assert.ok(normaliseForecast(response('weather.home',many),'weather.home','hourly','°C',now).length<=192);
});
test('forecast fetches only the configured weather target and two retrieval actions, caching for thirty minutes',async()=>{
 const context=source(),calls=[],cache=createWeatherForecasts({source:()=>context,request:async(url,options)=>{calls.push({url,options});const {entity_id}=JSON.parse(options.body);return response(entity_id,[row(0),row(1)]);}});
 await Promise.all([cache.poll(now),cache.poll(now)]);assert.equal(calls.length,2);for(const call of calls){assert.equal(call.url,'http://ha.test/api/services/weather/get_forecasts?return_response');assert.equal(call.options.method,'POST');assert.equal(JSON.parse(call.options.body).entity_id,'weather.home');assert.ok(['hourly','daily'].includes(JSON.parse(call.options.body).type));}
 assert.equal(cache.status(now).hourly.fresh,true);await cache.poll(now+29*60000);assert.equal(calls.length,2);await cache.poll(now+30*60000);assert.equal(calls.length,4);assert.doesNotMatch(JSON.stringify(cache.status(now+31*60000)),/private-token|Authorization/);
});
test('forecast types fail independently, retain still-fresh data on retry errors and expire without being reused as fresh',async()=>{
 const context=source();let fail=false,calls=0;const cache=createWeatherForecasts({source:()=>context,request:async(url,options)=>{calls++;const type=JSON.parse(options.body).type;if(fail&&type==='hourly')throw new Error('private connection details');return response(context.entityId,[row(0),row(1)]);}});
 await cache.poll(now);fail=true;await cache.poll(now+30*60000);let status=cache.status(now+31*60000);assert.equal(status.hourly.fresh,true);assert.ok(status.hourly.error);assert.equal(status.daily.error,null);await cache.poll(now+34*60000);assert.equal(calls,4);await cache.poll(now+35*60000);assert.equal(calls,5);
 status=cache.status(now+121*60000);assert.equal(status.hourly.fresh,false);assert.equal(status.daily.fresh,true);assert.doesNotMatch(JSON.stringify(status),/private connection/);
});
test('empty and unsupported forecasts are unavailable, while disabled, offline and non-weather selections never request services',async()=>{
 for(const change of [s=>s.enabled=false,s=>s.connected=false,s=>s.entityId='climate.boiler',s=>s.unit=null]){const context=source();change(context);let calls=0;const cache=createWeatherForecasts({source:()=>context,request:()=>calls++});await cache.poll(now);assert.equal(calls,0);}
 const cache=createWeatherForecasts({source,request:async()=>response('weather.home',[])});await cache.poll(now);assert.equal(cache.status(now).hourly.fresh,false);assert.ok(cache.status(now).hourly.error);
});
test('old forecast responses cannot repopulate a changed entity or Home Assistant generation',async()=>{
 const context=source(),gates=[],cache=createWeatherForecasts({source:()=>context,request:()=>new Promise(resolve=>gates.push(resolve))});const pending=cache.poll(now);assert.equal(gates.length,2);context.entityId='weather.other';context.generation++;cache.clear();gates.forEach(resolve=>resolve(response('weather.home',[row(0)])));await pending;assert.equal(cache.status(now).entityId,'weather.other');assert.equal(cache.status(now).hourly.points.length,0);
});
test('forecast configuration changes invalidate cached values and errors cannot leak previous-unit data',async()=>{
 const context=source(),cache=createWeatherForecasts({source:()=>context,request:async()=>response(context.entityId,[row(0,50)])});await cache.poll(now);assert.equal(cache.status(now).hourly.points[0].temperatureC,50);context.unit='°F';assert.equal(cache.status(now).hourly.points.length,0);await cache.poll(now+60000);assert.equal(cache.status(now+60000).hourly.points[0].temperatureC,10);
});
test('missing forecast units are explained without service requests or a permanent loading state',async()=>{
 const context={...source(),unit:null},cache=createWeatherForecasts({source:()=>context,request:()=>{throw new Error('must not call');}});await cache.poll(now);assert.match(cache.status(now).hourly.error,/units are unavailable/);assert.equal(cache.status(now).refreshing,false);
});
test('application polling collects current outdoor observations and forecasts without a browser or any heating service',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cold-forecast-')),calls=[],stamp=new Date().toISOString(),app=createApplication({dataDir:directory,haRequest:async(url,options)=>{calls.push({url,options});if(url.endsWith('/states'))return [{entity_id:'weather.home',state:'cloudy',last_reported:stamp,attributes:{temperature:10,temperature_unit:'°C'}}];const body=JSON.parse(options.body);return response(body.entity_id,[{datetime:stamp,temperature:10},{datetime:new Date(Date.now()+3600000).toISOString(),temperature:9}]);},haRegistryRequest:async()=>[]});
 t.after(async()=>{await app.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('cold-forecast-'));rmSync(absolute,{recursive:true,force:true});});
 const {store}=app.context;store.save('homeAssistant',{...store.config().homeAssistant,url:'http://ha.test'});store.secret('haToken','test-token');const plan=store.config().heatingPlan;store.save('heatingPlan',{...plan,weather:{...plan.weather,enabled:true,entityId:'weather.home'}});await app.tick();assert.equal(app.context.ha.forecasts.hourly.fresh,true);
 const sample=JSON.parse(store.db.prepare('SELECT snapshot FROM heating_samples ORDER BY at DESC LIMIT 1').get().snapshot);assert.equal(sample.boiler.outdoor_c,10);assert.equal(sample.boiler.outdoor_entity,'weather.home');assert.equal(sample.boiler.outdoor_kind,'reported');assert.ok(calls.filter(c=>c.options.method==='POST').every(c=>c.url.includes('/weather/get_forecasts?return_response')));
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const data=await(await fetch(`http://127.0.0.1:${app.server.address().port}/api/heating/analysis`)).json();assert.equal(data.outlook.planningOnly,true);assert.ok(data.outlook.scenarios.home.hourly.length>0);assert.doesNotMatch(JSON.stringify(data),/test-token/);
 const pair=app.context.boiler.pair(),reply=app.context.boiler.exchange(signedMessage({v:1,device_id:pair.deviceId,boot_id:'a'.repeat(32),request_id:'b'.repeat(16),sequence:1,mode:'Cold Harbour',telemetry:{flow_c:45}},pair.key));assert.equal(JSON.parse(reply.payload).authority,'pid');assert.equal(JSON.parse(reply.payload).lease_s,0);
});
