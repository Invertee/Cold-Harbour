import { createApplication } from './app.js';

const app = createApplication();
const host = process.env.HOST || (process.env.SUPERVISOR_TOKEN?'0.0.0.0':'127.0.0.1');
const port = Number(process.env.PORT || 8099);
const devicePort=Number(process.env.DEVICE_PORT || 8102);
app.deviceServer.listen(devicePort,process.env.DEVICE_HOST || '0.0.0.0',()=>console.log(`Signed boiler endpoint: port ${devicePort}`));
app.server.listen(port,host,()=>{
  console.log(`Cold Harbour\nLocal: http://${host === '0.0.0.0'?'localhost':host}:${port}\nStorage: ${process.env.DATA_DIR || './data'}`);
  app.startPolling();
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await app.close();process.exit(0);});
