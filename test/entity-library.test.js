import test from 'node:test';
import assert from 'node:assert/strict';
import {entityPage,defaultEntityView} from '../public/modules/entities.js';

const entities=[
  {entity_id:'sensor.room_10',state:'20',attributes:{friendly_name:'Room 10',unit_of_measurement:'°C'}},
  {entity_id:'sensor.room_2',state:'-2',attributes:{friendly_name:'Room 2',unit_of_measurement:'°C'}},
  {entity_id:'climate.lounge',state:'heat',attributes:{friendly_name:'Lounge valve'}},
  {entity_id:'sensor.power',state:'100',attributes:{friendly_name:'House power',unit_of_measurement:'W'}},
  {entity_id:'sensor.missing',state:'unavailable',attributes:{friendly_name:'Missing sensor'}},
  {entity_id:'switch.unknown',state:'unknown',attributes:{}},
];
const view=values=>({...defaultEntityView,...values});
test('entity search combines case-insensitive words, IDs, units and state with type and availability filters',()=>{
  assert.deepEqual(entityPage(entities,view({query:'ROOM °c'})).items.map(e=>e.entity_id),['sensor.room_2','sensor.room_10']);
  assert.equal(entityPage(entities,view({query:'sensor.power 100'})).total,1);
  assert.equal(entityPage(entities,view({type:'sensor',availability:'available'})).total,3);
  assert.equal(entityPage(entities,view({availability:'unavailable'})).total,2);
  assert.equal(entityPage(entities,view({type:'climate',query:'lounge'})).total,1);
  assert.equal(entityPage(entities,view({query:'no match'})).total,0);
});
test('entity sorting uses natural names and numeric states in both directions without changing source order',()=>{
  const before=structuredClone(entities),numbers=entities.filter(e=>Number.isFinite(Number(e.state)));
  assert.deepEqual(entityPage(numbers,view({sort:'state'})).items.map(e=>e.state),['-2','20','100']);
  assert.deepEqual(entityPage(numbers,view({sort:'state',direction:'desc'})).items.map(e=>e.state),['100','20','-2']);
  assert.deepEqual(entityPage(entities,view({sort:'id',direction:'desc'})).items.map(e=>e.entity_id),[...entities].map(e=>e.entity_id).sort((a,b)=>new Intl.Collator('en-GB',{numeric:true}).compare(b,a)));
  assert.deepEqual(entities,before);
});
test('entity pagination limits rendered rows and clamps pages after filters change',()=>{
  const many=Array.from({length:121},(_,i)=>({entity_id:`sensor.room_${i}`,state:String(i),attributes:{friendly_name:`Room ${i}`}}));
  let result=entityPage(many,view({page:2}));assert.equal(result.items.length,25);assert.equal(result.start,26);assert.equal(result.end,50);assert.equal(result.pages,5);
  result=entityPage(many,view({page:100}));assert.equal(result.page,5);assert.equal(result.items.length,21);
  result=entityPage(many,view({page:5,query:'not-found'}));assert.equal(result.page,1);assert.equal(result.pages,1);assert.equal(result.start,0);assert.equal(result.end,0);
  result=entityPage(many,view({pageSize:100}));assert.equal(result.items.length,100);
});
