import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCreature, syncGroups, prepareCreature, emissionRate, fallbackStep } from './ecology.mjs';
test('process identity survives reorder; exited groups disappear; cap is respected',()=>{
 const slots=Array.from({length:2},emptyCreature);
 syncGroups(slots,[{name:'a'},{name:'b'}]);slots[0].x=.123;
 syncGroups(slots,[{name:'b'},{name:'a'},{name:'c'}]);assert.equal(slots[0].group.name,'a');assert.equal(slots[0].x,.123);
 syncGroups(slots,[{name:'b'},{name:'c'}]);assert.deepEqual(slots.map(c=>c.group.name),['c','b']);
 syncGroups(slots,[]);assert.ok(slots.every(c=>!c.group));
});
test('activity follows measured CPU; idle and stale organisms stop',()=>{
 const c={...emptyCreature(),group:{name:'worker',cpu:.2,rssBytes:1048576}};
 prepareCreature(c,.016,true);assert.ok(c.speed>0);const small=c.size;
 c.group.rssBytes=1073741824;prepareCreature(c,.016,true);assert.ok(c.size>small);
 prepareCreature(c,.016,false);assert.equal(c.speed,0);
 c.group.cpu=0;prepareCreature(c,.016,true);const x=c.x;fallbackStep([c],1,1);assert.equal(c.x,x);
 c.group.cpu=null;prepareCreature(c,.016,true);assert.equal(c.speed,0);
});
test('no bubbles are fabricated for unavailable or idle network traffic',()=>{
 for(const value of [null,undefined,NaN,0,-1])assert.equal(emissionRate(value),0);
 assert.ok(emissionRate(1024)>0);assert.ok(emissionRate(1e20)<=16);
});
