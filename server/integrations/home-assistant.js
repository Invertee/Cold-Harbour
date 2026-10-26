import { fetchJson,HttpError } from '../http.js';
import {readEntityRegistry,isCaptureEntry} from './ha-registry.js';
import {createWeatherForecasts} from './weather-forecasts.js';
import {trvzbContext,prepareTrvzb} from './trvzb.js';

export function connection(store) {
  if (process.env.SUPERVISOR_TOKEN) return { url: 'http://supervisor/core', token: process.env.SUPERVISOR_TOKEN };
  const { url } = store.config().homeAssistant;
  return { url, token: store.secret('haToken') };
}

export function createHomeAssistant(store, request = fetchJson, registryRequest=readEntityRegistry) {
  let states = [], fetchedAt = null, error = null, generation = 0,registry=[],registryAt=0,registryAttempt=0,registryError=null,captureBusy=false,temperatureUnit=null,unitsAt=0;
  const forecasts=createWeatherForecasts({request,source:()=>{
    const weather=store.config().heatingPlan.weather,{url,token}=connection(store),entityId=weather.forecastEntityId || (weather.entityId?.startsWith('weather.')?weather.entityId:'');
    return {url,token,entityId,enabled:weather.enabled,generation,unit:states.find(s=>s.entity_id===entityId)?.attributes?.temperature_unit || temperatureUnit,connected:Boolean(fetchedAt)&&!error&&Date.now()-Date.parse(fetchedAt)<=45000};
  }});
  return {
    get status() { return { connected: Boolean(fetchedAt) && !error, fetchedAt, error, configured: Boolean(connection(store).url && connection(store).token), supervisor: Boolean(process.env.SUPERVISOR_TOKEN) }; },
    get states() { return states; },
    get temperatureUnit(){return temperatureUnit;},
    get generation(){return generation;},
    get forecasts(){return forecasts.status();},
    async pollForecasts(now=Date.now()){await forecasts.poll(now);},
    invalidate() { generation++; forecasts.clear();states = []; fetchedAt = null; error = null;registry=[];registryAt=registryAttempt=0;registryError=null;temperatureUnit=null;unitsAt=0;this.presenceMemory?.clear();this.demandMemory?.clear();this.occupancyMemory={}; },
    async poll() {
      const { url,token } = connection(store);
      if (!url || !token) return;
      const version = generation;
      try {
        const result = await request(`${url}/api/states`,{ headers: { Authorization: `Bearer ${token}` } });
        if (version !== generation) return;
        if (!Array.isArray(result)) throw new Error('Home Assistant returned invalid entity data.');
        states = result; fetchedAt = new Date().toISOString(); error = null;
        if(result.some(s=>/^(climate|weather)\./.test(s.entity_id)&&!['°C','°F'].includes(s.attributes?.temperature_unit || s.attributes?.unit_of_measurement))&&Date.now()-unitsAt>=60000){
          unitsAt=Date.now();
          try{const config=await request(`${url}/api/config`,{headers:{Authorization:`Bearer ${token}`}});if(version!==generation)return;temperatureUnit=['°C','°F'].includes(config?.unit_system?.temperature)?config.unit_system.temperature:null;}catch{if(version===generation)temperatureUnit=null;}
        }
        if(Date.now()-registryAttempt>=60000){
          registryAttempt=Date.now();
          try{const entries=await registryRequest(url,token);if(version!==generation)return;registry=entries;registryAt=Date.now();registryError=null;}
          catch{if(version===generation)registryError='Capture discovery unavailable. Use the switch on the ESPHome device page, or check Home Assistant permissions.';}
        }
        await this.pollForecasts();
      } catch (err) { if (version === generation) error = err.message; }
    },
    radiatorContext(entityId,now=Date.now()){
      const state=states.find(s=>s.entity_id===entityId),entry=registry.find(e=>e.entity_id===entityId),fresh=this.status.connected&&now-Date.parse(fetchedAt)<45000;
      const verified=Boolean(entry?.platform==='zha'&&!entry.disabled_by&&now-registryAt<300000&&entityId?.startsWith('climate.'));
      return {state,verified,fresh,temperatureUnit:state?.attributes?.temperature_unit || state?.attributes?.unit_of_measurement || temperatureUnit};
    },
    valveContext(entityId,now=Date.now()){
      return trvzbContext(entityId,{states,registry,fresh:this.status.connected&&now-Date.parse(fetchedAt)<=45000,registryFresh:now-registryAt<300000,temperatureUnit});
    },
    prepareValve(room,plan,now=Date.now()){return prepareTrvzb(room,plan,this.valveContext(room.radiatorEntity,now));},
    async applyValvePlan(room,plan,isCurrent){
      const originalGeneration=generation;
      const guard=()=>{
        const stored=store.list('rooms').find(r=>r.id===room.id);
        if(typeof isCurrent!=='function'||!isCurrent()||generation!==originalGeneration||stored?.radiatorEntity!==room.radiatorEntity||store.config().thermostat?.mode!=='active')throw new HttpError(409,'Smart Thermostat control changed.');
        if(!Number.isInteger(plan.opening)||plan.opening<0||plan.opening>100||plan.closing!==100||!Number.isFinite(plan.deviceTarget)||plan.deviceTarget<5||plan.deviceTarget>35)throw new HttpError(400,'Invalid valve plan.');
        const current=this.valveContext(room.radiatorEntity),prepared=prepareTrvzb(room,plan,current);
        if(!prepared.ready)throw new HttpError(409,prepared.reason);
        return {current,prepared};
      };
      const send=async(domain,service,entityId,values)=>{
        guard();const {url,token}=connection(store);
        await request(`${url}/api/services/${domain}/${service}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({entity_id:entityId,...values})});
        guard();
      };
      const {current,prepared}=guard();
      // Close first when reducing demand, and remove Adaptive mode before asking for Heat.
      // Every target comes from the fixed, same-device ZHA controls discovered above.
      if(current.adaptive.state!=='off')await send('switch','turn_off',current.adaptive.entityId,{});
      if(current.closing.value!==100)await send('number','set_value',current.closing.entityId,{value:100});
      if(current.opening.value!==plan.opening)await send('number','set_value',current.opening.entityId,{value:plan.opening});
      const attrs=current.state.attributes;
      if(current.state.state!=='heat'||typeof attrs.temperature!=='number'||Math.abs(attrs.temperature-prepared.nativeTarget)>=.01)await send('climate','set_temperature',room.radiatorEntity,{temperature:prepared.nativeTarget,hvac_mode:'heat'});
    },
    async applyRadiator(roomId,mode,command){
      const room=store.list('rooms').find(r=>r.id===roomId);
      if(!room||!['follow','focus','pause'].includes(mode)||room.radiatorMode!==mode)throw new HttpError(409,'Radiator control is not enabled for this room.');
      const entityId=room.radiatorEntity,context=this.radiatorContext(entityId),attrs=context.state?.attributes || {};
      if(!context.verified||!context.fresh||!context.state||['unknown','unavailable'].includes(context.state.state))throw new HttpError(409,'Wait for a fresh, verified ZHA radiator.');
      const {url,token}=connection(store),version=generation;
      let service,body;
      if(mode==='pause'){
        if(command!==null||!attrs.hvac_modes?.includes('off'))throw new HttpError(409,'This radiator does not expose an Off mode.');
        service='set_hvac_mode';body={entity_id:entityId,hvac_mode:'off'};
      }else{
        if(!attrs.hvac_modes?.includes('heat')||!(attrs.supported_features&1)||!['°C','°F'].includes(context.temperatureUnit)||!Number.isFinite(command)||!Number.isFinite(attrs.min_temp)||!Number.isFinite(attrs.max_temp)||command<attrs.min_temp||command>attrs.max_temp)throw new HttpError(409,'This radiator does not expose a usable heating target.');
        service='set_temperature';body={entity_id:entityId,temperature:command,hvac_mode:'heat'};
      }
      await request(`${url}/api/services/climate/${service}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(version!==generation)throw new HttpError(409,'Home Assistant changed; check the radiator in Home Assistant.');
    },
    captureStatus(now=Date.now()){
      const fresh=this.status.connected&&now-Date.parse(fetchedAt)<45000;
      const candidates=registry.filter(isCaptureEntry).map(entry=>({entityId:entry.entity_id,name:states.find(state=>state.entity_id===entry.entity_id)?.attributes?.friendly_name || entry.name || entry.original_name,disabled:Boolean(entry.disabled_by),state:states.find(state=>state.entity_id===entry.entity_id)?.state || 'unavailable'}));
      const chosen=store.config().homeAssistant.captureEntity;
      const selected=chosen?candidates.find(entry=>entry.entityId===chosen):candidates.length===1?candidates[0]:null;
      const ready=Boolean(fresh&&now-registryAt<300000&&selected&&!selected.disabled&&['on','off'].includes(selected.state));
      return {ready,busy:captureBusy,selected:selected || null,candidates,automatic:!chosen&&Boolean(selected),error:registryError || (!fresh?'Connect Home Assistant to start capture here.':chosen&&!selected?'The selected entity is no longer a verified ESPHome message-capture switch.':!selected?candidates.length>1?'Choose the boiler’s message-capture switch in Connections.':'No ESPHome message-capture switch found. Check its entities, including disabled entities.':selected.disabled?'Enable this entity in Home Assistant first.':!['on','off'].includes(selected.state)?'The capture switch is unavailable.':null)};
    },
    async setMessageCapture(enabled){
      if(typeof enabled!=='boolean')throw new HttpError(400,'Choose whether capture should start or stop.');
      const capture=this.captureStatus();
      if(captureBusy)throw new HttpError(409,'A capture request is already in progress.');
      if(!capture.ready)throw new HttpError(409,capture.error || 'Message capture is not available.');
      if(enabled&&capture.selected.state==='on')throw new HttpError(409,'Capture is already running; it will stop automatically.');
      const {url,token}=connection(store),version=generation,entityId=capture.selected.entityId;
      captureBusy=true;
      try{
        // This path is restricted to the registry-verified diagnostic switch.
        // Never accept entity IDs, service names or heating targets from this request.
        await request(`${url}/api/services/switch/${enabled?'turn_on':'turn_off'}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({entity_id:entityId})});
        if(version!==generation)throw new HttpError(409,'Home Assistant connection changed; check capture on the device.');
        store.log('capture',`OpenTherm message capture ${enabled?'start':'stop'} requested.`);
        return {requested:true,enabled,entityId,message:enabled?'Five-minute capture requested. Wait for the next ESP exchange (up to 30 seconds).':'Capture stop requested. Wait for the next ESP exchange.'};
      }finally{captureBusy=false;}
    },
  };
}

export function temperature(entity, now = Date.now(), maxAge = 1800000, climate = false, fallbackUnit=null) {
  return temperatureReport(entity,now,maxAge,climate,fallbackUnit).value;
}

export function temperatureReport(entity, now = Date.now(), maxAge = 1800000, climate = false, fallbackUnit=null) {
  const at=Date.parse(entity?.last_reported || entity?.last_updated);
  const report={value:null,reportedAt:Number.isFinite(at)?new Date(at).toISOString():null,status:'invalid'};
  if (!entity || ['unknown','unavailable'].includes(entity.state)) return {...report,status:'unavailable'};
  const value = climate ? entity.attributes?.current_temperature : entity.state;
  if (value === null || value === undefined || value === '') return report;
  if(!['number','string'].includes(typeof value)||typeof value==='string'&&!value.trim())return report;
  const number = Number(value);
  const unit = climate?entity.attributes?.temperature_unit || entity.attributes?.unit_of_measurement || fallbackUnit:entity.attributes?.unit_of_measurement;
  if (unit !== '°C' && unit !== '°F') return report;
  if (!Number.isFinite(number) || !Number.isFinite(at) || at-now>60000) return report;
  const celsius = unit === '°F' ? (number-32)*5/9 : number;
  if(celsius < -20 || celsius > 60)return report;
  if(now-at>maxAge)return {...report,status:'stale'};
  return {...report,value:celsius,status:'fresh'};
}

export function powerReading(entity,now=Date.now()) {
  if (!entity || entity.state === '' || entity.state === null || ['unknown','unavailable'].includes(entity.state)) return null;
  const unit = entity.attributes?.unit_of_measurement;
  const value = Number(entity.state);
  const at = Date.parse(entity.last_reported || entity.last_updated);
  if (!['W','kW'].includes(unit) || !Number.isFinite(value) || !Number.isFinite(at) || at>now+60000) return null;
  return {watts:value*(unit === 'kW' ? 1000 : 1),at:new Date(at).toISOString()};
}
