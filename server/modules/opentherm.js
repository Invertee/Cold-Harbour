const names={0:'Status',1:'CH control setpoint',3:'Slave configuration',5:'Fault flags',14:'Maximum modulation',17:'Relative modulation',18:'CH pressure',19:'DHW flow',25:'Primary water temperature',26:'DHW temperature',27:'Outside temperature',28:'Return water temperature',48:'DHW setpoint bounds',49:'CH setpoint bounds',56:'DHW setpoint',57:'Maximum CH setpoint',116:'Burner starts',120:'Burner hours'};
const types=['Read data','Write data','Invalid data','Reserved','Read acknowledgement','Write acknowledgement','Data invalid','Unknown data ID'];
const f88=new Set([1,14,17,18,19,25,26,27,28,56,57]);
export function decodeFrame(row){
  const out={...row,typeName:types[row.type],name:names[row.data_id] || `Data ID ${row.data_id}`,dataHex:`0x${row.data.toString(16).padStart(4,'0').toUpperCase()}`};
  // Read requests contain placeholders; negative replies and status bitfields are not temperatures.
  if([1,4,5].includes(row.type)&&f88.has(row.data_id))out.value=(row.data>32767?row.data-65536:row.data)/256;
  if(row.type===4&&row.data_id===0)out.status={fault:Boolean(row.data&1),chActive:Boolean(row.data&2),dhwActive:Boolean(row.data&4),flame:Boolean(row.data&8)};
  return out;
}
