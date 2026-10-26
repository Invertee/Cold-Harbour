// ZHA registry identity is used rather than editable entity IDs or displayed names.
const definitions={opening:['number','Valve opening degree','valve_opening_degree'],closing:['number','Valve closing degree','valve_closing_degree'],adaptive:['switch','Adaptive mode','smart_temperature_control']};
export function trvzbContext(entityId,{states,registry,fresh,registryFresh,temperatureUnit}){
 const entry=registry.find(e=>e.entity_id===entityId),state=states.find(s=>s.entity_id===entityId);
 const verified=Boolean(fresh&&registryFresh&&entry?.platform==='zha'&&!entry.disabled_by&&entry.device_id&&entityId?.startsWith('climate.'));
 const result={verified,state,temperatureUnit:state?.attributes?.temperature_unit || state?.attributes?.unit_of_measurement || temperatureUnit};
 for(const [key,[domain,name,suffix]] of Object.entries(definitions)){
  const candidates=verified?registry.filter(e=>e.platform==='zha'&&e.device_id===entry.device_id&&e.entity_id.startsWith(domain+'.')&&(e.original_name===name||e.translation_key===suffix||e.unique_id?.endsWith('-'+suffix)||e.unique_id?.endsWith('_'+suffix))):[];
  const candidate=candidates.length===1?candidates[0]:null,value=states.find(s=>s.entity_id===candidate?.entity_id);
  result[key]=candidate?{entityId:candidate.entity_id,enabled:!candidate.disabled_by,state:value?.state ?? null,value:value&&value.state!==''&&Number.isFinite(Number(value.state))?Number(value.state):null,attributes:value?.attributes || {}}:null;
 }
 return result;
}
export function prepareTrvzb(room,plan,device){
 const unavailable=reason=>({ready:false,confirmed:false,reason});
 if(!device?.verified||!device.state||['unknown','unavailable'].includes(device.state.state))return unavailable('Wait for fresh, registry-verified ZHA radiator controls.');
 const attrs=device.state.attributes || {},unit=device.temperatureUnit;
 if(!attrs.hvac_modes?.includes('heat')||!(attrs.supported_features&1)||!['°C','°F'].includes(unit)||!Number.isFinite(attrs.min_temp)||!Number.isFinite(attrs.max_temp)||attrs.min_temp>=attrs.max_temp)return unavailable('The radiator must expose Manual/Heat mode and a usable target range.');
 for(const key of ['opening','closing']){
  const item=device[key];if(!item?.enabled||item.value===null||item.value<0||item.value>100||item.attributes.min!==0||item.attributes.max!==100||!Number.isFinite(item.attributes.step)||item.attributes.step<=0||item.attributes.step>1)return unavailable('Enable Valve opening degree and Valve closing degree on the ZHA device.');
 }
 if(!device.adaptive?.enabled||!['on','off'].includes(device.adaptive.state))return unavailable('Enable the TRVZB Adaptive mode entity so Cold Harbour can keep it off.');
 const native=unit==='°F'?plan.deviceTarget*9/5+32:plan.deviceTarget,step=attrs.target_temp_step || .5;
 if(!Number.isFinite(step)||step<=0||step>5)return unavailable('The radiator target step is unavailable.');
 const target=Number(Math.max(attrs.min_temp,Math.min(attrs.max_temp,Math.ceil(native/step)*step)).toFixed(3));
 const confirmed=device.adaptive.state==='off'&&device.opening.value===plan.opening&&device.closing.value===100&&device.state.state==='heat'&&typeof attrs.temperature==='number'&&Math.abs(attrs.temperature-target)<.01;
 return {ready:true,confirmed,deviceTarget:unit==='°F'?(target-32)*5/9:target,nativeTarget:target,reason:confirmed?'Requested settings reported by Home Assistant':'Waiting for the requested valve settings; physical travel is not measured'};
}
