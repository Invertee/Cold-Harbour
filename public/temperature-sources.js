export const temperatureUnit=(entity,fallback=null)=>entity?.attributes?.temperature_unit || entity?.attributes?.unit_of_measurement || fallback;
export const isTemperatureSource=entity=>entity.entity_id.startsWith('sensor.')?['°C','°F'].includes(entity.attributes?.unit_of_measurement):entity.entity_id.startsWith('climate.')&&Object.hasOwn(entity.attributes || {},'current_temperature');
export function temperatureSourceOptions(entities){
  return entities.filter(isTemperatureSource).map(entity=>[entity.entity_id,`${entity.attributes?.friendly_name || entity.entity_id}${entity.entity_id.startsWith('climate.')?' · thermostat measured temperature':''} · ${entity.entity_id}`]);
}
