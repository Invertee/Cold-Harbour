import {HttpError} from '../http.js';

export function readEntityRegistry(url,token,Socket=WebSocket){
  return new Promise((resolve,reject)=>{
    const endpoint=new URL(url==='http://supervisor/core'?'http://supervisor/core/websocket':`${url}/api/websocket`);endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
    let socket,done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);try{socket?.close();}catch{}error?reject(error):resolve(value);};
    const fail=()=>finish(new HttpError(502,'Home Assistant entity discovery unavailable. Check the connection and account permissions.'));
    const timer=setTimeout(fail,4000);
    try{socket=new Socket(endpoint);socket.addEventListener('error',fail);socket.addEventListener('close',()=>{if(!done)fail();});
      socket.addEventListener('message',event=>{
        try{const message=JSON.parse(event.data);
          if(message.type==='auth_required')socket.send(JSON.stringify({type:'auth',access_token:token}));
          else if(message.type==='auth_ok')socket.send(JSON.stringify({id:1,type:'config/entity_registry/list'}));
          else if(message.type==='auth_invalid')fail();
          else if(message.type==='result'&&message.id===1){if(message.success&&Array.isArray(message.result))finish(null,message.result);else fail();}
        }catch{fail();}
      });
    }catch{fail();}
  });
}
export function isCaptureEntry(entry){
  return entry&&entry.platform==='esphome'&&/^switch\.[a-z0-9_]+$/.test(entry.entity_id)&&(
    entry.original_name==='OpenTherm Message Capture'||/(?:^|[-_])opentherm[_-]message[_-]capture$/.test(entry.unique_id || '')
  );
}
