import {fetchJson,HttpError} from '../http.js';
import {notificationTarget,str} from '../validate.js';
import {connection} from './home-assistant.js';

const defaultTitle='Cold Harbour';
const testMessage='This is a test notification from Cold Harbour.';

// Only explicit destinations are offered: Companion app actions and notify entities.
// Never use notify.notify, which may select an unexpected destination.
export function notificationDevices(services,states) {
  const actions=services.find(item=>item.domain==='notify')?.services || {};
  const targets=Object.keys(actions).filter(service=>/^mobile_app_[a-z0-9_]+$/.test(service)).map(service=>({
    id:`service:notify.${service}`,name:actions[service]?.name || service.slice(11).replaceAll('_',' '),
    address:`notify.${service}`,kind:'Companion app',available:true,supportsTitle:true,
  }));
  if(Object.hasOwn(actions,'send_message'))for(const state of states){
    if(!/^notify\.[a-z0-9_]+$/.test(state.entity_id))continue;
    targets.push({id:`entity:${state.entity_id}`,name:state.attributes?.friendly_name || state.entity_id,
      address:state.entity_id,kind:'Notify entity',available:state.state!=='unavailable',
      supportsTitle:Boolean(state.attributes?.supported_features&1)});
  }
  return targets.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true})||a.id.localeCompare(b.id));
}

export function createNotifications(store,ha,request=fetchJson) {
  let busy=false;
  const snapshot=()=>({...connection(store),generation:ha.generation});
  const guard=original=>{
    const current=snapshot();
    if(current.generation!==original.generation||current.url!==original.url||current.token!==original.token)
      throw new HttpError(409,'Home Assistant connection changed. Refresh devices before sending again.');
  };
  async function discover(original=snapshot()){
    if(!original.url||!original.token)return {configured:false,targets:[],error:'Connect Home Assistant in Settings → Connections to load notification devices.'};
    try{
      const options={headers:{Authorization:`Bearer ${original.token}`}};
      const [services,states]=await Promise.all([request(`${original.url}/api/services`,options),request(`${original.url}/api/states`,options)]);
      guard(original);
      if(!Array.isArray(services)||!Array.isArray(states))throw new HttpError(502,'Home Assistant returned invalid notification discovery data.');
      return {configured:true,targets:notificationDevices(services,states),error:null};
    }catch(error){
      guard(original);
      return {configured:true,targets:[],error:error.status?error.message:'Unable to load notification devices. Check Home Assistant and try again.'};
    }
  }
  function messageValues(body,isTest){
    const title=str(body.title ?? defaultTitle,'Notification title',120)||defaultTitle;
    const message=str(body.message ?? (isTest?testMessage:undefined),'Notification message',2000);
    if(!message)throw new HttpError(400,'Enter a notification message.');
    return {title,message};
  }
  async function deliver(body,isTest){
    const values=messageValues(body,isTest),config=store.config().notifications;
    const ids=isTest?[notificationTarget(body.target)]:config.targets;
    if(!isTest&&!config.enabled)throw new HttpError(409,'Enable notifications and save at least one device first.');
    if(!ids.length)throw new HttpError(400,'Choose at least one notification device.');
    if(busy)throw new HttpError(409,'A notification is already being sent. Wait for its result.');
    busy=true;
    try{
      const original=snapshot(),discovery=await discover(original);
      if(discovery.error)throw new HttpError(discovery.configured?502:409,discovery.error);
      const selected=ids.map(id=>discovery.targets.find(target=>target.id===id));
      if(isTest&&(!selected[0]||!selected[0].available))throw new HttpError(409,'The selected device is unavailable. Refresh devices and choose an available destination.');
      const results=[];
      for(let index=0;index<ids.length;index++){
        guard(original);
        if(!isTest&&JSON.stringify(store.config().notifications)!==JSON.stringify(config))throw new HttpError(409,'Notification settings changed. Check the results on your devices before sending again.');
        const device=selected[index];
        if(!device?.available){results.push({target:ids[index],accepted:false,error:'This notification device is no longer available.'});continue;}
        const entity=device.id.startsWith('entity:'),service=entity?'send_message':device.address.slice(7);
        const payload={message:values.message,...(device.supportsTitle?{title:values.title}:{}),...(entity?{entity_id:device.address}:{})};
        try{
          await request(`${original.url}/api/services/notify/${service}`,{method:'POST',headers:{Authorization:`Bearer ${original.token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
          results.push({target:device.id,accepted:true});
        }catch(error){
          const message=error.status?error.message:'Home Assistant could not accept the notification. Check the connection and try again.';
          if(isTest)throw new HttpError(502,message);
          results.push({target:device.id,accepted:false,error:message});
        }
        guard(original);
      }
      const accepted=results.every(result=>result.accepted);
      store.log('notification',`${isTest?'Test notification':'Notification'}: Home Assistant accepted ${results.filter(result=>result.accepted).length} of ${results.length} device requests.`);
      return {accepted,results,message:accepted?'Home Assistant accepted the notification. Check your device to confirm delivery.':'Some devices could not be notified. Check the per-device results before retrying.'};
    }finally{busy=false;}
  }
  return {discover:()=>discover(),test:body=>deliver(body,true),send:body=>deliver(body,false)};
}
