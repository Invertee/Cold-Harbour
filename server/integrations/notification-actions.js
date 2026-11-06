// A persistent, authenticated HA event subscription lets Companion app buttons
// work without exposing a callback endpoint outside Home Assistant ingress.
export function createNotificationActions({source,onAction,Socket=WebSocket}){
 let socket=null,identity='',ready=false,closed=false,retryAt=0,deadline=0,lastPing=0,pong=true,error=null;
 const status=()=>({ready,error});
 const disconnect=()=>{const old=socket;socket=null;ready=false;try{old?.close();}catch{}};
 return {
  status,
  sync(now=Date.now()){
   if(closed)return status();
   const config=source(),key=JSON.stringify([config.url,config.token,config.generation]);
   if(key!==identity||!config.enabled){disconnect();identity=key;retryAt=0;error=null;}
   if(!config.enabled||!config.url||!config.token)return status();
   if(socket&&(!ready&&now>deadline||ready&&!pong&&now-lastPing>15000)){disconnect();error='Phone action connection timed out. Retrying automatically.';retryAt=now+15000;}
   if(socket){
    if(ready&&pong&&now-lastPing>=30000){pong=false;lastPing=now;try{socket.send(JSON.stringify({id:2,type:'ping'}));}catch{disconnect();retryAt=now+15000;}}
    return status();
   }
   if(now<retryAt)return status();
   deadline=now+10000;retryAt=now+15000;
   let current;
   const fail=()=>{if(socket!==current)return;disconnect();error='Phone actions unavailable. Check Home Assistant connection and event permissions.';};
   try{
    const url=new URL(config.url==='http://supervisor/core'?'http://supervisor/core/websocket':`${config.url}/api/websocket`);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    socket=current=new Socket(url);
    current.addEventListener('error',fail);current.addEventListener('close',fail);
    current.addEventListener('message',event=>{
     if(socket!==current||closed)return;
     // Ignore messages as soon as credentials or settings change, even before
     // the next server poll notices and replaces this socket.
     const latest=source();
     if(!latest.enabled||JSON.stringify([latest.url,latest.token,latest.generation])!==identity){disconnect();return;}
     try{
      const message=JSON.parse(event.data);
      if(message.type==='auth_required')current.send(JSON.stringify({type:'auth',access_token:config.token}));
      else if(message.type==='auth_ok')current.send(JSON.stringify({id:1,type:'subscribe_events',event_type:'mobile_app_notification_action'}));
      else if(message.type==='auth_invalid')fail();
      else if(message.type==='result'&&message.id===1){if(!message.success){fail();return;}ready=true;error=null;pong=true;lastPing=Date.now();}
      else if(message.type==='pong'&&message.id===2)pong=true;
      else if(ready&&message.type==='event'&&message.id===1&&message.event?.event_type==='mobile_app_notification_action'){
       Promise.resolve(onAction(message.event)).catch(()=>{});
      }
     }catch{fail();}
    });
   }catch{disconnect();error='Phone actions unavailable. Check Home Assistant connection and event permissions.';}
   return status();
  },
  close(){closed=true;disconnect();},
 };
}
