import { periodRange } from '../time.js';
import { powerReading } from '../integrations/home-assistant.js';
import { resolveEnergyEntities,integrationFuelSummary } from '../integrations/octopus-entities.js';
export { powerReading } from '../integrations/home-assistant.js';

export function energySummary(context,period='today',now=Date.now()) {
  const {store,ha}=context,config=store.config(),range=periodRange(period,now,config.general.timezone);
  const mapping=resolveEnergyEntities(config,ha.states || []);
  const electricity=integrationFuelSummary(context,mapping,'electricity',range,period,now),gas=integrationFuelSummary(context,mapping,'gas',range,period,now);
  const demand=mapping.electricity.roles.demand,source=demand?`ha:${demand.entity_id}`:null;
  const live=source?store.db.prepare('SELECT watts,at FROM readings WHERE source=? ORDER BY at DESC LIMIT 1').get(source) || null:null;
  const fresh=Boolean(live && ha.status.connected && powerReading(demand,now) && now-Date.parse(live.at)<180000 && Date.parse(live.at)<=now+60000);
  const samples=source?store.db.prepare('SELECT at,watts FROM readings WHERE source=? AND at>? ORDER BY at').all(source,new Date(now-3600000).toISOString()):[];
  return {...electricity,period,range,live:live?{...live,fresh,source:'Home Assistant',entityId:demand.entity_id}:null,samples,electricity,gas,energySource:'homeAssistant',ha:ha.status,integration:{connected:ha.status.connected,meters:mapping.meters,warnings:[...electricity.warnings,...gas.warnings]}};
}
export const energyModule = {
  id:'energy',name:'Energy',description:'Electricity and gas usage, costs and tariffs from Home Assistant.',
  register({route,context}) {
    route('GET','/api/energy',({url})=>energySummary(context,['today','yesterday','week'].includes(url.searchParams.get('period'))?url.searchParams.get('period'):'today'));
    route('GET','/api/energy/discovery',()=>({...resolveEnergyEntities(context.store.config(),context.ha.states || []),connected:context.ha.status.connected}));
  },
};
