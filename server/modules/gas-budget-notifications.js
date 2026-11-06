import {createHash,randomBytes} from 'node:crypto';
import {connection} from '../integrations/home-assistant.js';
import {createNotificationActions} from '../integrations/notification-actions.js';

const retryMs=5*60000;
export function createGasBudgetNotifications(context,{Socket}={}){
 const {store,ha}=context;let busy=false,closed=false,actionSync=null;
 const rule=()=>store.config().notifications.gasBudget;
 const enabled=()=>{const c=store.config();return c.notifications.enabled&&c.notifications.gasBudget.enabled&&c.gasBudget.enabled;};
 const scope=s=>createHash('sha256').update(JSON.stringify([connection(store),s.source,s.timezone,s.settings.unit,s.settings.dailyLimit,rule()])).digest('hex');
 function handleAction(event,now=Date.now()){
  if(closed||event?.event_type!=='mobile_app_notification_action'||!enabled()||!rule().pauseAction)return false;
  const action=event.data?.action;
  if(typeof action!=='string'||!/^COLD_HARBOUR_PAUSE_[a-f0-9]{48}$/.test(action))return false;
  const row=store.db.prepare('SELECT * FROM gas_budget_notifications WHERE action=?').get(action),s=context.gasBudget.status(now);
  if(!row||!row.accepted||row.consumed||row.expires_at<=now||row.day!==s.day||row.scope!==scope(s)||!rule().targets.includes(row.target))return false;
  store.db.exec('BEGIN');
  try{
   store.db.prepare('UPDATE gas_budget_notifications SET consumed=1 WHERE scope=? AND day=?').run(row.scope,row.day);
   context.gasBudget.pause(now);
   store.db.exec('COMMIT');
  }catch(error){store.db.exec('ROLLBACK');throw error;}
  // Status and the signed boiler response see the pause immediately. Sync the
  // radiators too; the normal polling loop retries any unavailable controls.
  actionSync=context.thermostat?.sync().catch(()=>{}).finally(()=>{actionSync=null;});
  return true;
 }
 const actions=createNotificationActions({Socket,source:()=>({...connection(store),generation:ha.generation,enabled:enabled()&&rule().pauseAction}),onAction:handleAction});
 return {
  status:()=>actions.status(),
  handleAction,
  async check(now=Date.now()){
   if(closed)return;
   actions.sync(now);
   if(busy||!enabled())return;
   const s=context.gasBudget.status(now),r=rule();
   if(!s.fresh||s.used===null||!s.source||s.used<s.settings.dailyLimit*r.thresholdPercent/100||s.manualPause)return;
   // Wait briefly for the subscription handshake before offering a live button.
   // If subscription fails, still deliver the warning with instructions for
   // pausing in the app instead of silently withholding the budget warning.
   const actionReady=r.pauseAction&&actions.status().ready;
   if(r.pauseAction&&!actionReady&&!actions.status().error)return;
   const original=scope(s),generation=ha.generation;
   const isCurrent=()=>{
    if(closed||!enabled()||ha.generation!==generation)return false;
    const current=context.gasBudget.status();
    return !current.manualPause&&current.day===s.day&&scope(current)===original&&!store.db.prepare('SELECT 1 FROM gas_budget_notifications WHERE scope=? AND day=? AND consumed=1').get(original,s.day);
   };
   busy=true;
   try{
    for(const target of r.targets){
     if(!isCurrent())break;
     let row=store.db.prepare('SELECT * FROM gas_budget_notifications WHERE scope=? AND target=? AND day=?').get(original,target,s.day);
     if(row?.accepted||row?.consumed||row&&now-row.attempted_at<retryMs)continue;
     if(!row){
      const action=`COLD_HARBOUR_PAUSE_${randomBytes(24).toString('hex')}`;
      store.db.prepare('INSERT INTO gas_budget_notifications(scope,target,day,action,attempted_at,expires_at) VALUES (?,?,?,?,?,?)').run(original,target,s.day,action,now,Date.parse(s.resetsAt));
      row={action};
     }else store.db.prepare('UPDATE gas_budget_notifications SET attempted_at=? WHERE action=?').run(now,row.action);
     const amount=n=>s.settings.unit==='cost'?`£${n.toFixed(2)}`:`${n.toFixed(1)} kWh`;
     const title=s.dailyReached?'Daily gas budget reached':'Approaching daily gas budget';
     const message=`${amount(s.used)} of ${amount(s.settings.dailyLimit)} used today (${Math.round(s.used/s.settings.dailyLimit*100)}%). ${amount(s.remaining)} remaining. Meter readings can be delayed.${actionReady?' Pause heating until local midnight; frost protection stays available. Applies in Smart Thermostat Active mode.':r.pauseAction?' Phone action unavailable. Pause heating from Gas today & heating budget in Cold Harbour.':''}`;
     try{
      const result=await context.notifications.sendBudget({target,title,message,action:actionReady?row.action:null,isCurrent});
      if(result.accepted)store.db.prepare('UPDATE gas_budget_notifications SET accepted=1 WHERE action=?').run(row.action);
     }catch{
      store.log('notification','Gas budget warning could not be accepted. It will retry in five minutes while the gas reading is fresh.');
     }
    }
   }finally{busy=false;}
  },
  close(){closed=true;actions.close();return actionSync;},
 };
}
