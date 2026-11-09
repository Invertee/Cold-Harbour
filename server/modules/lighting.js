import {daylightKelvin,lightCapabilities} from '../../public/lighting-model.js';

const tolerance=75,retryDelay=60000;
export function sunReading(ha,now=Date.now()){
  const sun=ha.states.find(state=>state.entity_id==='sun.sun'),elevation=sun?.attributes?.elevation,at=Date.parse(sun?.last_updated || sun?.last_reported);
  const ready=Boolean(ha.status.connected&&['above_horizon','below_horizon'].includes(sun?.state)&&typeof elevation==='number'&&Number.isFinite(elevation)&&elevation>=-90&&elevation<=90&&Number.isFinite(at)&&now-at<=15*60000&&at-now<=60000);
  return {ready,elevation:ready?elevation:null,rising:ready&&typeof sun.attributes.rising==='boolean'?sun.attributes.rising:null,
    reason:ready?null:!ha.status.connected?'Connect Home Assistant to follow daylight.':'Waiting for a fresh sun.sun elevation from Home Assistant.'};
}
export function lightTarget(state,group,elevation,settings){
  const capability=lightCapabilities(state);
  if(!capability.supported)return null;
  const min=Math.max(group.minKelvin,capability.minKelvin),max=Math.min(group.maxKelvin,capability.maxKelvin);
  if(min>max)return null;
  return Math.max(min,Math.min(max,daylightKelvin(group,elevation,settings)));
}
export function createLighting({store,ha}){
  const memory=new Map();let pending=null,closed=false;
  const signature=(settings,group)=>JSON.stringify([ha.generation,settings.transitionSeconds,settings.warmElevation,settings.coolElevation,group]);
  function read(now=Date.now()){
    const settings=store.config().lighting,sun=sunReading(ha,now);
    const lights=ha.states.filter(state=>state.entity_id.startsWith('light.')).map(state=>({entityId:state.entity_id,name:state.attributes?.friendly_name || state.entity_id,state:state.state,...lightCapabilities(state)}));
    return {settings,sun,connected:ha.status.connected,lights,groups:settings.groups.map(group=>({...group,targetKelvin:sun.ready?daylightKelvin(group,sun.elevation,settings):null,
      lights:group.entities.map(entityId=>{
        const light=lights.find(light=>light.entityId===entityId),state=ha.states.find(state=>state.entity_id===entityId),entry=memory.get(entityId);
        const target=sun.ready?lightTarget(state,group,sun.elevation,settings):null;
        const current=light?.currentKelvin ?? null,inRange=current!==null&&current>=Math.max(group.minKelvin,light?.minKelvin)&&current<=Math.min(group.maxKelvin,light?.maxKelvin);
        const status=!settings.enabled||!group.enabled?'paused':!sun.ready?'waiting':!light||!['on','off'].includes(light.state)?'unavailable':!light.supported?'unsupported':target===null?'range_unavailable':light.state==='off'?'off':entry?.error?'error':entry&&now<entry.until?'adjusting':!light.transition&&current===null?'temperature_unavailable':inRange&&Math.abs(current-target)<=tolerance?'following':'waiting';
        return {entityId,name:light?.name || entityId,state:light?.state || 'unavailable',currentKelvin:current,targetKelvin:target,status,transition:light?.transition || false,error:entry?.error || null};
      })}))};
  }
  async function run(now){
    const settings=store.config().lighting,sun=sunReading(ha,now),seen=new Set();
    if(closed||!settings.enabled||!sun.ready){memory.clear();return;}
    for(const group of settings.groups){
      if(!group.enabled)continue;
      for(const entityId of group.entities){
        seen.add(entityId);
        const state=ha.states.find(state=>state.entity_id===entityId),capability=lightCapabilities(state),target=lightTarget(state,group,sun.elevation,settings),key=signature(settings,group);
        if(state?.state!=='on'||target===null){memory.delete(entityId);continue;}
        let entry=memory.get(entityId);
        if(entry?.key!==key){memory.delete(entityId);entry=null;}
        if(entry?.error){if(now<entry.retryAt)continue;memory.delete(entityId);entry=null;}
        const current=capability.currentKelvin;
        if(!entry){
          if(current!==null&&current>=Math.max(group.minKelvin,capability.minKelvin)&&current<=Math.min(group.maxKelvin,capability.maxKelvin)&&Math.abs(current-target)<=tolerance&&state.attributes?.color_mode==='color_temp')continue;
          // A device without native fading needs a reported starting temperature.
          if(!capability.transition&&current===null)continue;
          entry={key,from:current,target,startedAt:now,until:now+settings.transitionSeconds*1000+(capability.transition?10000:0),lastSentAt:null,native:capability.transition};
          memory.set(entityId,entry);
        }
        if(entry.native&&entry.lastSentAt!==null&&now<entry.until)continue;
        if(entry.native&&entry.lastSentAt!==null&&now>=entry.until){memory.delete(entityId);continue;}
        if(entry.lastSentAt!==null&&now-entry.lastSentAt<4500)continue;
        const elapsed=Math.max(0,Math.min(1,(now-entry.startedAt)/(settings.transitionSeconds*1000)));
        if(!entry.native&&elapsed===0)continue;
        const kelvin=entry.native?entry.target:Math.round(entry.from+(entry.target-entry.from)*elapsed);
        const isCurrent=()=>{
          const latest=store.config().lighting,active=latest.groups.find(value=>value.id===group.id);
          return !closed&&latest.enabled&&active?.enabled&&active.entities.includes(entityId)&&signature(latest,active)===key&&sunReading(ha).ready;
        };
        try{
          await ha.applyLightTemperature(entityId,kelvin,entry.native?settings.transitionSeconds:0,isCurrent);
          entry.lastSentAt=now;
          if(!entry.native&&elapsed>=1)memory.delete(entityId);
        }catch(error){
          if(!isCurrent()){memory.delete(entityId);continue;}
          entry.error=error.status===409?error.message:'The light could not be adjusted. Retrying in a minute.';entry.retryAt=now+retryDelay;entry.until=now;
        }
      }
    }
    for(const entityId of memory.keys())if(!seen.has(entityId))memory.delete(entityId);
  }
  return {read,sync(now=Date.now()){
    if(closed)return Promise.resolve();
    if(pending)return pending;
    pending=run(now).finally(()=>{pending=null;});return pending;
  },reset(){memory.clear();},async close(){closed=true;await pending;memory.clear();}};
}
export const lightingModule={id:'lighting',name:'Daylight lighting',description:'Grouped white temperatures that follow the sun, with gentle transitions.',register({route,context}){
  context.lighting=createLighting(context);
  route('GET','/api/lighting',()=>context.lighting.read());
}};
