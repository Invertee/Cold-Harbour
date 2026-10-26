import {createCipheriv,createDecipheriv,randomBytes,scrypt,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import metadata from '../package.json' with {type:'json'};
import {defaults} from './defaults.js';
import {HttpError} from './http.js';
import {validateConfig,validateRoom,validateRule} from './validate.js';

export const MAX_BACKUP_BYTES=8*1024*1024;
const deriveKey=promisify(scrypt),format='cold-harbour-backup',version=1;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw new HttpError(400,message);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function passwordValue(value){
  if(typeof value!=='string'||value.length<10||value.length>1024)fail('Use a backup password between 10 and 1024 characters.');
  return value;
}
function keys(value,allowed,label){
  if(!object(value)||Object.keys(value).length!==allowed.length||allowed.some(key=>!Object.hasOwn(value,key)))fail(`Invalid ${label}.`);
}
function bytes(value,length,label){
  if(typeof value!=='string'||!value.length||value.length>MAX_BACKUP_BYTES||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail(`Invalid backup ${label}.`);
  const result=Buffer.from(value,'base64');
  if(result.toString('base64')!==value)fail(`Invalid backup ${label}.`);
  if(length&&result.length!==length)fail(`Invalid backup ${label}.`);
  return result;
}
function snapshot(store){
  return {config:store.config(),rooms:store.list('rooms'),rules:store.list('rules'),secrets:{haToken:store.secret('haToken'),boilerKey:store.secret('boilerKey')}};
}

// Only configuration crosses instances. Host keys, cached readings and history stay local.
export function validateBackupData(data){
  keys(data,['appVersion','exportedAt','config','rooms','rules','secrets'],'backup contents');
  if(typeof data.appVersion!=='string'||data.appVersion.length>80||typeof data.exportedAt!=='string'||!Number.isFinite(Date.parse(data.exportedAt)))fail('Invalid backup metadata.');
  // Backups from before notification settings existed remain importable.
  if(object(data.config)&&!Object.hasOwn(data.config,'notifications'))data={...data,config:{...data.config,notifications:structuredClone(defaults.notifications)}};
  keys(data.config,Object.keys(defaults),'backup settings');
  const config={};
  for(const [section,initial] of Object.entries(defaults)){
    keys(data.config[section],Object.keys(initial),`${section} settings`);
    if(section==='thermostat'){
      if(!['planning','active'].includes(data.config[section].mode))fail('Invalid thermostat mode.');
      config.thermostat={mode:'planning'};
    }else config[section]=validateConfig(section,data.config[section],initial);
  }
  if(config.heatingPlan.version!==2)fail('This backup needs a current High/Low heating schedule.');
  if(!Array.isArray(data.rooms)||data.rooms.length>1000||!Array.isArray(data.rules)||data.rules.length>10000)fail('Invalid backup rooms or schedules.');
  const uniqueRecords=(records,validate)=>{
    const ids=new Set();
    return records.map(record=>{
      if(!object(record)||typeof record.id!=='string'||!record.id.trim()||record.id.length>80)fail('Every backup record needs an ID.');
      const value=validate(record);
      if(ids.has(value.id))fail('Backup record IDs must be unique.');
      ids.add(value.id);return value;
    });
  };
  const valves=new Set();
  const rooms=uniqueRecords(data.rooms,record=>{
    const room=validateRoom(record);
    if(room.radiatorEntity){
      if(valves.has(room.radiatorEntity))fail('A radiator valve cannot be assigned to multiple rooms.');
      valves.add(room.radiatorEntity);
    }
    return {...room,radiatorMode:'monitor'};
  });
  const rules=uniqueRecords(data.rules,record=>validateRule(record,rooms));
  keys(data.secrets,['haToken','boilerKey'],'backup credentials');
  for(const name of ['haToken','boilerKey'])if(typeof data.secrets[name]!=='string'||data.secrets[name].length>4096)fail('Invalid backup credentials.');
  return {appVersion:data.appVersion,exportedAt:data.exportedAt,config,rooms,rules,secrets:{...data.secrets}};
}

export async function encryptBackup(data,password){
  passwordValue(password);
  const salt=randomBytes(16),iv=randomBytes(12),key=await deriveKey(password,salt,32);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`${format}:${version}`));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  const backup={format,version,encryption:{algorithm:'aes-256-gcm',kdf:'scrypt',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')},data:encrypted.toString('base64')};
  if(Buffer.byteLength(JSON.stringify(backup))>MAX_BACKUP_BYTES)fail('Configuration exceeds the 8 MB backup limit.');
  return backup;
}
export async function decryptBackup(backup,password){
  passwordValue(password);
  keys(backup,['format','version','encryption','data'],'backup file');
  if(backup.format!==format||backup.version!==version)fail('Unsupported backup format or version.');
  if(Buffer.byteLength(JSON.stringify(backup))>MAX_BACKUP_BYTES)fail('Backup exceeds the 8 MB limit.');
  keys(backup.encryption,['algorithm','kdf','salt','iv','tag'],'backup encryption');
  const encryption=backup.encryption;
  if(encryption.algorithm!=='aes-256-gcm'||encryption.kdf!=='scrypt')fail('Unsupported backup encryption.');
  const salt=bytes(encryption.salt,16,'salt'),iv=bytes(encryption.iv,12,'IV'),tag=bytes(encryption.tag,16,'tag'),encrypted=bytes(backup.data,null,'data');
  const key=await deriveKey(password,salt,32);
  let data;
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from(`${format}:${version}`));decipher.setAuthTag(tag);
    data=JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8'));
  }catch{fail('Cannot open backup. Check the password and that the file is intact.');}
  return validateBackupData(data);
}

export function registerBackups({route,context}){
  const {store,ha}=context,previews=new Map();
  route('POST','/api/backups/export',async({body})=>{
    const data={appVersion:metadata.version,exportedAt:new Date().toISOString(),...snapshot(store)};
    validateBackupData(data);
    return encryptBackup(data,body.password);
  });
  route('POST','/api/backups/preview',async({body})=>{
    const data=await decryptBackup(body.backup,body.password),now=Date.now();
    for(const [id,preview] of previews)if(preview.expiresAt<=now)previews.delete(id);
    if(previews.size>=20)previews.delete(previews.keys().next().value);
    const previewId=randomBytes(24).toString('hex');
    previews.set(previewId,{backupHash:hash(body.backup),currentHash:hash(snapshot(store)),expiresAt:now+10*60000});
    return {previewId,appVersion:data.appVersion,exportedAt:data.exportedAt,rooms:data.rooms.length,rules:data.rules.length,periods:data.config.heatingPlan.activities.length,
      timezone:data.config.general.timezone,homeAssistantUrl:data.config.homeAssistant.url,controllerId:data.config.boiler.deviceId,
      credentials:{haToken:Boolean(data.secrets.haToken),boilerKey:Boolean(data.secrets.boilerKey)},supervisor:Boolean(process.env.SUPERVISOR_TOKEN),mode:'planning'};
  });
  route('POST','/api/backups/import',async({body})=>{
    if(body.confirm!==true||typeof body.previewId!=='string')fail('Preview the backup and confirm replacement first.');
    const data=await decryptBackup(body.backup,body.password),preview=previews.get(body.previewId);
    if(!preview||preview.expiresAt<=Date.now()||preview.backupHash!==hash(body.backup)||preview.currentHash!==hash(snapshot(store)))throw new HttpError(409,'The preview expired or configuration changed. Preview the backup again before importing.');
    store.db.exec('BEGIN IMMEDIATE');
    try{
      for(const [section,value] of Object.entries(data.config))store.save(section,value);
      for(const [name,value] of Object.entries(data.secrets))store.secret(name,value);
      store.db.exec('DELETE FROM rules; DELETE FROM rooms; DELETE FROM boiler_devices;');
      for(const room of data.rooms)store.put('rooms',room);
      for(const rule of data.rules)store.put('rules',rule);
      store.log('backup','Configuration imported. Smart Thermostat returned to Planning; review connections and room mappings before selecting Active.');
      store.db.exec('COMMIT');
    }catch(error){store.db.exec('ROLLBACK');throw error;}
    ha.invalidate();context.thermostat.reset();context.boiler.reset();previews.clear();
    return {ok:true,mode:'planning',rooms:data.rooms.length};
  });
}
