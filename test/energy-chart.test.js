import test from 'node:test';
import assert from 'node:assert/strict';
import {cumulativeEnergyRows,energy} from '../public/modules/energy.js';

const interval=(hour,kwh,cost)=>({start:`2026-10-26T${hour}:00:00Z`,end:`2026-10-26T${hour}:30:00Z`,kwh,cost});

test('energy graph accumulates ordered intervals, including negative tariff charges',()=>{
  const rows=[interval('02',.5,-.05),interval('00',1,.2),interval('01',2,.4)];
  const result=cumulativeEnergyRows(rows);
  assert.deepEqual(result.map(row=>row.cumulativeKwh),[1,3,3.5]);
  assert.ok(Math.abs(result.at(-1).cumulativeCost-.55)<1e-10);
  assert.equal(result.slice(2)[0].cumulativeKwh,3.5);
  assert.equal(rows[0].cumulativeKwh,undefined);
  assert.deepEqual(cumulativeEnergyRows([]),[]);
});

test('missing readings never become zero or a falsely complete running total',()=>{
  const result=cumulativeEnergyRows([interval('00',1,.2),interval('01',2,null),interval('02',null,.3),interval('03',1,.1)]);
  assert.deepEqual(result.map(row=>row.cumulativeKwh),[1,3,null,null]);
  assert.deepEqual(result.map(row=>row.cumulativeCost),[.2,null,null,null]);
  assert.equal(cumulativeEnergyRows([interval('00',0,0)])[0].cumulativeCost,0);
});

test('fuel switch is above the graph and cumulative controls support both fuels',async t=>{
  const originalFetch=globalThis.fetch;
  const originalLocation=globalThis.location;
  globalThis.location={href:'http://localhost/'};
  const fuel={rows:[interval('00',1,.2)],kwh:1,cost:.2,unitRate:20,standingCharge:50};
  globalThis.fetch=async()=>({ok:true,json:async()=>({electricity:fuel,gas:fuel,range:{},samples:[],ha:{}})});
  t.after(()=>{globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;energy.fuel='electricity';energy.chartView='interval';});
  for(const selected of ['electricity','gas']){
    energy.fuel=selected;energy.chartView='cost';
    const html=await energy.render({config:{general:{timezone:'Europe/London'}}});
    assert.ok(html.indexOf('data-fuel=')<html.indexOf('class="energy-top"'));
    assert.equal((html.match(/data-fuel=/g)||[]).length,2);
    assert.match(html,/data-chart-view="energy"/);
    assert.match(html,/data-chart-view="cost" class="selected"/);
    assert.match(html,/excludes standing charges/);
    assert.equal(energy.chartData.rows[0].cumulativeKwh,1);
  }
});
