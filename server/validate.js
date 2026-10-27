import { HttpError } from './http.js';
import {defaultWeatherPlan} from './smart-thermostat.js';
import {groupHeatingSchedules} from './heating-plan.js';

const fail = message => { throw new HttpError(400,message); };
export const str = (value, label, max = 200) => typeof value === 'string' && value.length <= max ? value.trim() : fail(`${label} must be text (up to ${max} characters).`);
export const num = (value, label, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fail(`${label} must be between ${min} and ${max}.`);
export const bool = (value, label) => typeof value === 'boolean' ? value : fail(`${label} must be true or false.`);
export const entity = (value, domain) => { value = str(value, 'Entity'); if (value && !(domain ? new RegExp(`^${domain}\\.[a-z0-9_]+$`) : /^[a-z_]+\.[a-z0-9_]+$/).test(value)) fail('Choose a valid Home Assistant entity.'); return value; };
export const activities = ['auto','home','work','evening','sleep','away'];
export function notificationTarget(value) {
  const target=str(value,'Notification device',240);
  if(!/^(entity:notify\.[a-z0-9_]+|service:notify\.mobile_app_[a-z0-9_]+)$/.test(target))fail('Choose a valid notification device.');
  return target;
}
export function validateConfig(section, input, current) {
  const result = { ...current };
  for (const [key,value] of Object.entries(input)) {
    if (!Object.hasOwn(current,key)) fail(`Unknown setting: ${key}`);
    result[key] = value;
  }
  if (section === 'general') {
    if (result.mode !== 'listen') fail('This build supports listen-only monitoring.');
    str(result.timezone,'Timezone',80);
    try { new Intl.DateTimeFormat('en-GB',{ timeZone: result.timezone }).format(); } catch { fail('Choose a valid IANA timezone.'); }
  } else if (section === 'homeAssistant') {
    result.url = str(result.url,'Home Assistant URL',500).replace(/\/+$/,'');
    if (result.url) {
      let url; try { url = new URL(result.url); } catch { fail('Enter a valid Home Assistant URL.'); }
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Use the base Home Assistant HTTP(S) address without credentials or a path.');
    }
    result.powerEntity = entity(result.powerEntity,'sensor');
    result.captureEntity = entity(result.captureEntity,'switch');
  } else if (section === 'notifications') {
    result.enabled=bool(result.enabled,'Notifications');
    if(!Array.isArray(result.targets)||result.targets.length>20)fail('Choose up to 20 notification devices.');
    result.targets=result.targets.map(notificationTarget);
    if(new Set(result.targets).size!==result.targets.length)fail('Select each notification device only once.');
    if(result.enabled&&!result.targets.length)fail('Choose at least one notification device before enabling notifications.');
  } else if (section === 'energy') {
    for (const key of ['electricityMeter','gasMeter']) result[key] = str(result[key],'Meter',240);
    for (const key of Object.keys(result).filter(key=>!['electricityMeter','gasMeter'].includes(key))) result[key] = entity(result[key],'sensor');
  } else if (section === 'heating') {
    if (!activities.includes(result.activity)) fail('Invalid household activity.');
    num(result.staleMinutes,'Sensor freshness',5,180);
  } else if(section==='heatingPlan') {
    return validateHeatingPlan(result);
  } else if (section === 'boiler') {
    result.deviceId=str(result.deviceId,'Controller ID',64);
    if(!/^[a-z0-9_-]{1,64}$/.test(result.deviceId)) fail('Use a controller ID containing lowercase letters, numbers, hyphens or underscores.');
    num(result.historyDays,'Boiler history days',1,90);
  } else fail('Unknown settings section.');
  return result;
}

export function validateRoom(input) {
  if (input.sensorEntities !== undefined && !Array.isArray(input.sensorEntities)) fail('Temperature sensors must be a list.');
  const source=value=>{const id=entity(value);if(id&&!/^(sensor|climate)\./.test(id))fail('Choose a temperature sensor or thermostat measured temperature.');return id;};
  const sensorEntities = Array.isArray(input.sensorEntities) ? input.sensorEntities.map(source).filter(Boolean) : [source(input.sensorEntity || '')].filter(Boolean);
  if (sensorEntities.length > 12) fail('Choose no more than 12 temperature sensors per room.');
  if (new Set(sensorEntities).size !== sensorEntities.length) fail('A temperature sensor can only be selected once per room.');
  const room = { id: input.id ? str(input.id,'ID',80) : undefined, name: str(input.name,'Room name',60), sensorEntities, sensorEntity:sensorEntities[0] || '', occupancyEntity: entity(input.occupancyEntity || '', 'binary_sensor'), comfort: num(input.comfort,'Comfort temperature',10,28), eco: num(input.eco,'Eco temperature',5,25), weight: num(input.weight,'Room weight',0.1,5), icon: ['sofa','desk','bed','cup','home'].includes(input.icon) ? input.icon : 'home' };
  if (!room.name) fail('Give this room a name.');
  room.sensorFreshnessMinutes=input.sensorFreshnessMinutes==null?null:num(input.sensorFreshnessMinutes,'Room sensor freshness',5,1440);
  room.targetOffset=num(input.targetOffset ?? room.comfort-20,'Room target offset',-10,10);
  room.awayOffset=num(input.awayOffset ?? room.eco-16,'Room low temperature offset',-15,15);
  if (room.eco > room.comfort) fail('Eco temperature must not exceed comfort temperature.');
  room.radiatorEntity = entity(input.radiatorEntity || '', 'climate');
  room.presenceMode = input.presenceMode ?? 'priority';
  if (!['priority','comfort'].includes(room.presenceMode)) fail('Choose how presence affects this room.');
  room.presenceHoldMinutes = num(input.presenceHoldMinutes ?? 20,'Presence hold time',0,180);
  if (input.presenceRules !== undefined && !Array.isArray(input.presenceRules)) fail('Presence clues must be a list.');
  if ((input.presenceRules || []).length > 12) fail('Choose no more than 12 presence clues per room.');
  room.presenceRules = (input.presenceRules || []).map(rule=>{
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('Choose a valid presence clue.');
    const entityId = entity(rule.entityId);
    const domain = entityId.split('.')[0];
    if (!['binary_sensor','switch','input_boolean','media_player','sensor','person','device_tracker'].includes(domain)) fail('Choose a sensor, device or person for presence.');
    if (!['is','above'].includes(rule.condition)) fail('Choose a valid presence condition.');
    if (rule.condition === 'above' && domain !== 'sensor') fail('Above a value requires a numeric sensor.');
    const value = rule.condition === 'above' ? num(rule.value,'Presence threshold',-100000,100000) : str(rule.value,'Presence state',80);
    if (rule.condition === 'is' && (!value || ['unknown','unavailable'].includes(value))) fail('Choose an available state that indicates presence.');
    return {entityId,condition:rule.condition,value};
  });
  return room;
}
export function validateRule(input, rooms) {
  const rule = { id: input.id ? str(input.id,'ID',80) : undefined, name: str(input.name,'Schedule name',80), roomId: str(input.roomId,'Room',80), days: input.days, start: input.start, end: input.end, target: num(input.target,'Target',10,28), priority: num(input.priority,'Priority',1,5), activity: input.activity, enabled: bool(input.enabled,'Enabled') };
  if (!rule.name || !rooms.some(room => room.id === rule.roomId)) fail('Choose a room and schedule name.');
  if (!Array.isArray(rule.days) || !rule.days.length || rule.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) fail('Choose at least one valid weekday.');
  if (![rule.start,rule.end].every(time => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || rule.start === rule.end) fail('Choose different start and end times.');
  if (!activities.filter(a=>a !== 'auto' && a !== 'away').includes(rule.activity)) fail('Choose an activity for this schedule.');
  return rule;
}

export function validateHeatingPlan(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Choose a heating plan.');
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const id=value=>{const text=str(value,'Period ID',80);if(!/^[a-z0-9_-]+$/.test(text))fail('Use a valid period ID.');return text;};
  const plan={houseTarget:num(input.houseTarget,'House target',10,28),awayTarget:num(input.awayTarget,'Away target',5,25),manualActivity:str(input.manualActivity,'Selected period',80),occupancyMode:input.occupancyMode,awayDelayMinutes:num(input.awayDelayMinutes,'Away delay',0,120)};
  plan.version=input.version ?? 1;if(![1,2].includes(plan.version))fail('Choose a supported schedule version.');
  plan.setpointOverride=null;
  if(input.setpointOverride!=null){
    const hold=input.setpointOverride;
    if(plan.version!==2||!object(hold)||typeof hold.startedAt!=='string'||typeof hold.expiresAt!=='string'||!Number.isFinite(Date.parse(hold.startedAt))||!Number.isFinite(Date.parse(hold.expiresAt))||Date.parse(hold.expiresAt)<=Date.parse(hold.startedAt)||Date.parse(hold.expiresAt)-Date.parse(hold.startedAt)>26*3600000)fail('Choose a valid temporary setpoint period.');
    plan.setpointOverride={target:num(hold.target,'Temporary setpoint',7,28),periodKey:str(hold.periodKey,'Temporary setpoint period',512),startedAt:hold.startedAt,expiresAt:hold.expiresAt};
  }
  if(plan.version===2&&plan.manualActivity!=='auto')fail('Room priorities follow the schedule.');
  if(plan.version===2&&plan.awayTarget>plan.houseTarget)fail('Low temperature must not exceed the house setpoint.');
  if(input.weather!==undefined&&!object(input.weather))fail('Choose valid weather planning settings.');
  const weather={...defaultWeatherPlan,...input.weather};
  if(!object(weather)||Object.keys(weather).some(key=>!Object.hasOwn(defaultWeatherPlan,key)))fail('Choose valid weather planning settings.');
  const weatherEntity=entity(weather.entityId);if(weatherEntity&&!/^(weather|sensor)\./.test(weatherEntity))fail('Choose a weather entity or outside temperature sensor.');
  plan.weather={enabled:bool(weather.enabled,'Weather planning'),entityId:weatherEntity,forecastEntityId:entity(weather.forecastEntityId,'weather'),staleMinutes:num(weather.staleMinutes,'Weather freshness',15,360),designOutdoor:num(weather.designOutdoor,'Cold design temperature',-30,0),minFlow:num(weather.minFlow,'Minimum planned flow',25,60),maxFlow:num(weather.maxFlow,'Maximum planned flow',30,75),deficitGain:num(weather.deficitGain,'Room correction',0,15),maxPreheatMinutes:num(weather.maxPreheatMinutes,'Maximum planned warm-up',15,360)};
  if(plan.weather.maxFlow<plan.weather.minFlow)fail('Maximum flow must be at least the minimum flow.');
  if(!['auto','home','away'].includes(plan.occupancyMode))fail('Choose automatic, home or away occupancy.');
  if(!Array.isArray(input.people)||input.people.length>8)fail('Choose up to eight household people.');
  plan.people=input.people.map(person=>{if(!object(person))fail('Choose a household person.');const entityId=entity(person.entityId);if(!/^(person|device_tracker)\./.test(entityId))fail('Choose a Home Assistant person or device tracker.');return {entityId,name:str(person.name || '','Person name',60)};});
  if(new Set(plan.people.map(p=>p.entityId)).size!==plan.people.length)fail('Select each person only once.');
  if(!Array.isArray(input.activities)||!input.activities.length||input.activities.length>1024)fail('Choose between one and 1024 schedule periods.');
  plan.activities=input.activities.map(profile=>{
    if(!object(profile)||!object(profile.rooms))fail('Choose valid period settings.');
    const value={id:id(profile.id),name:str(profile.name,'Period name',60),targetMode:profile.targetMode,offset:num(profile.offset,'Period temperature offset',-10,10),rooms:{}};
    if(profile.houseTarget!==undefined)value.houseTarget=num(profile.houseTarget,'Period setpoint',7,28);
    if(value.id==='auto'||!value.name||!['house','setback'].includes(value.targetMode))fail('Give the period a name and target type.');
    if(Object.keys(profile.rooms).length>100)fail('Too many room overrides.');
    value.rooms=Object.fromEntries(Object.entries(profile.rooms).map(([roomId,override])=>{if(!roomId||roomId.length>80||!object(override))fail('Choose a valid room override.');const priority=plan.version===2?(['high','low'].includes(override.priority)?override.priority:fail('Room priority must be High or Low.')):num(override.priority,'Room priority',1,5);return [roomId,{offset:num(override.offset,'Room period offset',-20,20),priority,...(override.presenceSetback!==undefined?{presenceSetback:bool(override.presenceSetback,'Room presence setback')}:{})}];}));
    return value;
  });
  const ids=new Set(plan.activities.map(p=>p.id));
  if(ids.size!==plan.activities.length||plan.manualActivity!=='auto'&&!ids.has(plan.manualActivity))fail('Schedule periods must have unique IDs and a valid selection.');
  plan.scheduleOverride=null;
  if(input.scheduleOverride!=null){
    if(plan.version!==2||!object(input.scheduleOverride))fail('Choose a valid schedule override.');
    const entityId=entity(input.scheduleOverride.entityId,'binary_sensor'),activityId=id(input.scheduleOverride.activityId);
    if(!entityId||!ids.has(activityId))fail('Choose a binary sensor and an existing override period.');
    plan.scheduleOverride={entityId,activityId};
  }
  for(const key of ['timeline','awayTimeline']){
    const days=input[key];if(!Array.isArray(days)||days.length!==7)fail('A timeline needs all seven days.');
    plan[key]=days.map(slots=>{
      if(!Array.isArray(slots)||!slots.length||slots.length>96)fail('Each day needs between one and 96 periods.');
      let previous=-1;return slots.map(slot=>{if(!object(slot)||!Number.isInteger(slot.start)||slot.start<0||slot.start>1439||slot.start<=previous||previous===-1&&slot.start!==0||!ids.has(slot.activityId))fail('Periods must start at midnight, be in time order and use an existing period.');previous=slot.start;return {start:slot.start,activityId:slot.activityId};});
    });
  }
  return groupHeatingSchedules(plan);
}
