import test from 'node:test';
import assert from 'node:assert/strict';
import {chartReading,heatingDelta,phaseBands} from '../server/modules/boiler-history.js';

const heating={thermal_context:'space_heating',heating_sample_valid:true,ch_active:true,dhw_active:false,opentherm_age_s:1,ch_flow_c:48.3,ch_return_c:28.2};
test('delta-T is calculated only from fresh qualified central-heating temperatures',()=>{
 assert.equal(heatingDelta(heating),20.1);
 for(const extra of [{thermal_context:'domestic_hot_water'},{thermal_context:'settling_after_hot_water'},{thermal_context:'idle'},{dhw_active:true},{dhw_flow_l_min:2},{ch_active:false},{heating_sample_valid:false},{opentherm_age_s:90},{opentherm_age_s:undefined},{ch_return_c:undefined},{ch_flow_c:null}])assert.equal(heatingDelta({...heating,...extra}),null);
 assert.equal(heatingDelta({...heating,ch_return_c:50}),-1.7,'Preserve negative values rather than hide sensor mismatches');
 const point=chartReading('2026-10-22T10:00:00Z',{...heating,pressure_bar:1,pid_temperature_c:19});assert.equal(point.heating_delta_c,20.1);assert.equal(point.pressure_bar,undefined);assert.equal(point.pid_temperature_c,undefined);
});

test('reported phases merge contiguous samples and leave outages and unknown periods unshaded',()=>{
 const at=seconds=>new Date(Date.UTC(2026,9,22,10)+seconds*1000).toISOString();
 const points=[[0,'space_heating'],[30,'space_heating'],[60,'domestic_hot_water'],[90,'settling_after_hot_water'],[300,'space_heating'],[330,'unknown'],[360,'idle']].map(([s,thermal_context])=>({at:at(s),thermal_context}));
 assert.deepEqual(phaseBands(points,at(600)),[
  {start:at(0),end:at(60),phase:'space_heating'},
  {start:at(60),end:at(90),phase:'domestic_hot_water'},
  {start:at(90),end:at(180),phase:'settling_after_hot_water'},
  {start:at(300),end:at(330),phase:'space_heating'},
  {start:at(360),end:at(450),phase:'idle'},
 ]);
});
