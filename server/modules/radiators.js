import {HttpError} from '../http.js';
const modes=['monitor','follow','focus','pause'];
export function radiatorCommand(room,haContext,config){
 const mode=room.radiatorMode || 'monitor';
 if(mode==='monitor')return {mode,ready:false,reason:'Monitor only · no valve commands',service:null};
 if(config.thermostat?.mode==='active')return {mode,ready:false,reason:'Smart Thermostat manages the radiator',service:null};
 if(config.heatingPlan?.version===2)return {mode,ready:false,reason:'Smart Thermostat planning · radiator automation paused',service:null};
 const {state,verified,fresh,temperatureUnit}=haContext || {},attrs=state?.attributes || {};
 if(!verified||!fresh||!state||['unknown','unavailable'].includes(state.state))return {mode,ready:false,reason:'Waiting for a fresh, verified ZHA radiator',service:null};
 if(mode==='pause')return attrs.hvac_modes?.includes('off')?{mode,ready:true,service:'off',command:null,satisfied:state.state==='off',reason:'Radiator Off requested; its own frost behaviour remains device controlled'}:{mode,ready:false,service:null,reason:'This radiator does not expose Off mode'};
 if(!room.fresh)return {mode,ready:false,service:null,reason:'Room temperature unavailable · holding the last valve setting'};
 if(!attrs.hvac_modes?.includes('heat')||!(attrs.supported_features&1)||!['°C','°F'].includes(temperatureUnit)||!Number.isFinite(attrs.min_temp)||!Number.isFinite(attrs.max_temp)||attrs.max_temp<=attrs.min_temp)return {mode,ready:false,service:null,reason:'Heating target or temperature units unavailable'};
 const desired=mode==='focus'?Math.max(5,Math.min(28,config.heatingPlan.houseTarget+(room.targetOffset ?? room.comfort-20))):room.target;
 if(!Number.isFinite(desired)||desired<5||desired>38)return {mode,ready:false,service:null,reason:'Planned room target unavailable'};
 const native=temperatureUnit==='°F'?desired*9/5+32:desired,step=Number.isFinite(attrs.target_temp_step)&&attrs.target_temp_step>0&&attrs.target_temp_step<=5?attrs.target_temp_step:0.5;
 const low=attrs.min_temp,high=attrs.max_temp,command=Math.max(low,Math.min(high,Math.round(native/step)*step));
 const reported=attrs.temperature,satisfied=state.state==='heat'&&typeof reported==='number'&&Number.isFinite(reported)&&Math.abs(reported-command)<Math.max(0.01,step/2);
 return {mode,ready:true,service:'temperature',command:Number(command.toFixed(3)),targetC:temperatureUnit==='°F'?(command-32)*5/9:command,requestedTargetC:desired,satisfied,reason:mode==='focus'?'Using the home room target':'Following the planned room target'};
}

export function createRadiatorControl(context,summary){
 const {store,ha}=context,attempts=new Map();let busy=false,generation=ha.generation;
 const clearGeneration=()=>{if(generation!==ha.generation){attempts.clear();generation=ha.generation;}};
 const roomById=id=>summary().rooms.find(r=>r.id===id);
 return {
  status(roomId,now=Date.now()){
   clearGeneration();const room=roomById(roomId);if(!room)return null;
   const current=ha.radiatorContext?.(room.radiatorEntity,now),mode=room.radiatorMode || 'monitor',plan=radiatorCommand(room,current,store.config()),last=attempts.get(roomId);
   const verified=Boolean(current?.verified&&current.fresh&&current.state&&!['unknown','unavailable'].includes(current.state.state));
   return {...plan,mode,canControl:verified,lastAttemptAt:last?.at?new Date(last.at).toISOString():null,lastError:plan.satisfied?null:last?.error || null,pending:Boolean(last&&!last.error&&!plan.satisfied&&mode!=='monitor'),reason:mode==='monitor'?'Monitor only · no valve commands':plan.reason};
  },
  async setMode(roomId,mode){
   if(typeof roomId!=='string'||!modes.includes(mode))throw new HttpError(400,'Choose a room and Monitor, Follow plan, Focus or Pause.');
   const stored=store.list('rooms').find(r=>r.id===roomId);if(!stored?.radiatorEntity)throw new HttpError(404,'Map a radiator to this room first.');
   if(mode!=='monitor'){const room={...roomById(roomId),radiatorMode:mode},command=radiatorCommand(room,ha.radiatorContext?.(room.radiatorEntity),store.config());if(!command.ready)throw new HttpError(409,command.reason);}
   store.put('rooms',{...stored,radiatorMode:mode});attempts.delete(roomId);store.log('radiator',`${stored.name}: ${mode}`);
   await this.sync();return this.status(roomId);
  },
  async sync(now=Date.now()){
   if(busy)return;busy=true;clearGeneration();
   try{
    const config=store.config(),rooms=summary(now).rooms;
    for(const room of rooms){
     const current=ha.radiatorContext?.(room.radiatorEntity,now),plan=radiatorCommand(room,current,config);
     if(!plan.ready||plan.satisfied)continue;
     const signature=JSON.stringify([room.radiatorEntity,plan.mode,plan.service,plan.command]),last=attempts.get(room.id);
     if(last&&last.signature===signature&&now-last.at<300000)continue;
     // At most one changed target per minute; unchanged unconfirmed targets retry
     // after five minutes. Do not invent device acknowledgement from an HTTP reply.
     if(last&&now-last.at<60000)continue;
     attempts.set(room.id,{at:now,signature,error:null});
     try{await ha.applyRadiator(room.id,plan.mode,plan.command);store.log('radiator',`${room.name}: ${plan.service==='off'?'Off':`${plan.targetC.toFixed(1)}°C`} requested`);}
     catch(error){attempts.set(room.id,{at:now,signature,error:error.status?error.message:'Radiator command failed; check Home Assistant.'});}
    }
   }finally{busy=false;}
  },
 };
}
