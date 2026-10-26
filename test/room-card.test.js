import test from 'node:test';
import assert from 'node:assert/strict';
import {targetDistance,roomCard} from '../public/room-card.js';

test('target distance shows signed differences on a common capped scale',()=>{
 const room={name:'Office',fresh:true,current:18,target:20};
 assert.match(targetDistance(room),/2.0°C below target/);assert.match(targetDistance(room),/left:18%/);
 assert.match(targetDistance({...room,current:22}),/2.0°C above target/);
 assert.match(targetDistance({...room,current:20}),/At target/);
 assert.match(targetDistance({...room,current:26.3}),/6.3°C above target/);assert.match(targetDistance({...room,current:26.3}),/left:98%/);
 assert.match(targetDistance({...room,current:0,target:1}),/1.0°C below target/);
});

test('missing readings never appear on target and room names are escaped',()=>{
 const room={id:'office',name:'<Office>',current:null,target:20,fresh:false};
 assert.match(targetDistance(room),/No recent reading/);assert.doesNotMatch(targetDistance(room),/distance-reading/);
 const html=roomCard(room,{leadRoomId:null});assert.match(html,/&lt;Office&gt;/);assert.doesNotMatch(html,/<Office>/);
 assert.match(html,/Temperature unavailable/);
});
