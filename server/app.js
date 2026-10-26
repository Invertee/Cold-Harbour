import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './db.js';
import { createHomeAssistant } from './integrations/home-assistant.js';
import { energyModule,powerReading } from './modules/energy.js';
import { captureHomeAssistantEnergy } from './integrations/octopus-entities.js';
import { heatingModule } from './modules/heating.js';
import { boilerModule,deviceHandler } from './modules/boiler.js';
import { HttpError,json,readJson } from './http.js';
import { validateConfig,validateRoom,validateRule,str } from './validate.js';
import {registerBackups,MAX_BACKUP_BYTES} from './backups.js';
import {createNotifications} from './integrations/notifications.js';

const publicDir = fileURLToPath(new URL('../public/',import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};

export function createApplication({dataDir=process.env.DATA_DIR || resolve('data'),haRequest,haRegistryRequest,ingressOnly=Boolean(process.env.SUPERVISOR_TOKEN),modules=[]} = {}) {
  const store = createStore(dataDir), ha = createHomeAssistant(store,haRequest,haRegistryRequest);
  const context = {store,ha};
  context.notifications=createNotifications(store,ha,haRequest);
  const routes = new Map();
  const route = (method,path,handler)=>{ const key=`${method} ${path}`; if(routes.has(key)) throw new Error(`Duplicate route ${key}`); routes.set(key,handler); };
  const installedModules = [energyModule,heatingModule,boilerModule,...modules];
  for (const module of installedModules) module.register({route,context});
  registerBackups({route,context});
  let ticking = null, timer, lastPrune = 0,closed = false;
  async function tick() {
    if (closed) return;
    if (ticking) return ticking;
    ticking = (async()=>{
      const now = Date.now();
      await ha.poll();
      await context.radiators.sync();
      await context.thermostat.sync();
      const {homeAssistant} = store.config();
      if (ha.status.connected && homeAssistant.powerEntity) {
        const value = powerReading(ha.states.find(s=>s.entity_id === homeAssistant.powerEntity));
        if (value) store.db.prepare('INSERT OR REPLACE INTO readings VALUES (?,?,?)').run(`ha:${homeAssistant.powerEntity}`,value.at,value.watts);
      }
      captureHomeAssistantEnergy(context,now);
      context.heatingHistory.capture(now);
      context.heatingOutlook.read(now);
      if (now-lastPrune>3600000) { store.prune(); lastPrune=now; }
    })().finally(()=>{ticking=null;});
    return ticking;
  }
  function publicConfig() {
    return {...store.config(),secrets:{haToken:Boolean(store.secret('haToken')),boilerKey:Boolean(store.secret('boilerKey'))},supervisor:Boolean(process.env.SUPERVISOR_TOKEN)};
  }
  route('GET','/api/settings',publicConfig);
  route('GET','/api/notifications',()=>context.notifications.discover());
  route('POST','/api/notifications/test',({body})=>context.notifications.test(body));
  route('POST','/api/notifications/send',({body})=>context.notifications.send(body));
  route('GET','/api/modules',()=>installedModules.map(({id,name,description})=>({id,name,description})));
  route('GET','/api/entities',()=>({entities:ha.states.map(({entity_id,state,attributes,last_reported,last_updated})=>({entity_id,state,attributes,last_reported,last_updated})),status:ha.status}));
  route('GET','/api/rooms',()=>store.list('rooms'));
  route('GET','/api/rules',()=>store.list('rules'));
  route('GET','/api/events',()=>store.events());
  route('POST','/api/refresh',async()=>{ await tick(); return {ha:ha.status}; });
  route('POST','/api/settings',async({body})=>{
    const section = str(body.section,'Section',40);
    const current = ['general','homeAssistant','notifications','energy','heating','heatingPlan','boiler'].includes(section) ? store.config()[section] : null;
    if (!current || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw new HttpError(400,'Choose a settings section and values.');
    const input = {...body.values};
    const secrets = [];
    for (const [field,name] of section === 'homeAssistant' ? [['token','haToken']] : []) {
      if (field in input) { secrets.push([name,str(input[field],field,4096)]); delete input[field]; }
    }
    const next = validateConfig(section,input,current);
    store.db.exec('BEGIN');
    try {
      for (const [name,value] of secrets) store.secret(name,value);
      store.save(section,next);
      store.db.exec('COMMIT');
    } catch(err) { store.db.exec('ROLLBACK'); throw err; }
    if (section === 'homeAssistant') ha.invalidate();
    store.log('settings',`${section} settings updated`);
    void tick().catch(()=>{});
    return publicConfig();
  });
  for (const table of ['rooms','rules']) {
    route('POST',`/api/${table}`,({body})=>{
      const value = table === 'rooms' ? validateRoom(body) : validateRule(body,store.list('rooms'));
      if (table === 'rooms' && value.radiatorEntity) {
        if (store.list('rooms').some(room=>room.id!==value.id && room.radiatorEntity===value.radiatorEntity)) throw new HttpError(400,'This radiator valve is already assigned to another room.');
      }
      if(table==='rooms'){const previous=store.list('rooms').find(r=>r.id===value.id);value.radiatorMode=previous?.radiatorEntity===value.radiatorEntity?previous?.radiatorMode || 'monitor':'monitor';}
      const saved = store.put(table,value); store.log('settings',`${table === 'rooms'?'Room':'Schedule'} saved: ${saved.name}`); return saved;
    });
    route('DELETE',`/api/${table}`,({url})=>{const id=url.searchParams.get('id');if(!id)throw new HttpError(400,'Missing ID.');store.remove(table,id);return {ok:true};});
  }
  const server = createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
    try {
      const url = new URL(req.url,'http://mods.local');
      const remote = req.socket.remoteAddress?.replace(/^::ffff:/,'');
      if (req.method === 'GET' && url.pathname === '/health' && ['127.0.0.1','::1','172.30.32.2'].includes(remote)) return json(res,{status:'ok',version:'0.14.1'});
      if (ingressOnly && remote !== '172.30.32.2') throw new HttpError(403,'Access Cold Harbour through Home Assistant ingress.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403,'Cross-site requests are not allowed.');
      if (url.pathname.startsWith('/api/')) {
        const handler = routes.get(`${req.method} ${url.pathname}`);
        if (!handler) throw new HttpError(404,'API route not found.');
        if (['POST','PUT','DELETE','PATCH'].includes(req.method) && req.headers['x-mods-request'] !== '1') throw new HttpError(403,'Missing request validation header.');
        const body = ['POST','PUT','PATCH'].includes(req.method) ? await readJson(req,['/api/backups/preview','/api/backups/import'].includes(url.pathname)?MAX_BACKUP_BYTES+16384:65536) : undefined;
        return json(res,await handler({req,url,body}));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405,'Method not allowed.');
      const file = resolve(publicDir,'.'+decodeURIComponent(url.pathname === '/'?'/index.html':url.pathname));
      if (!file.startsWith(publicDir.endsWith(sep)?publicDir:publicDir+sep) || !mime[extname(file)]) throw new HttpError(404,'File not found.');
      let content;
      try { content = await readFile(file); } catch { throw new HttpError(404,'File not found.'); }
      res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':'no-cache'});
      res.end(req.method === 'HEAD'?undefined:content);
    } catch(err) { json(res,{error:err.status?err.message:'An internal error occurred.'},err.status || 500); if(!err.status) console.error('Cold Harbour request failed:',err.name); }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  const deviceServer=createServer(deviceHandler(context));
  deviceServer.requestTimeout=10000;deviceServer.headersTimeout=5000;
  return {server,deviceServer,context,tick,
    startPolling() { void tick().catch(err=>console.error('Cold Harbour polling failed:',err.name)); timer=setInterval(()=>void tick().catch(err=>console.error('Cold Harbour polling failed:',err.name)),15000);timer.unref(); },
    async close() { closed=true;clearInterval(timer);await ticking;await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>deviceServer.close(resolve))]);store.close(); },
  };
}
