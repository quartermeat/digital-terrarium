import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCreature, syncGroups, prepareCreature, emissionRate, stepCreatures, bodyBars, bodyStack, runnableShare } from './ecology.mjs';
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
 c.group.cpu=0;prepareCreature(c,.016,true);const x=c.x;stepCreatures([c],1,1);assert.equal(c.x,x);
 c.group.cpu=null;prepareCreature(c,.016,true);assert.equal(c.speed,0);
});
test('thread, process and runnable counts map to bounded body structure',()=>{
 assert.equal(bodyBars(1),1);assert.ok(bodyBars(64)>bodyBars(4));
 for(const value of [null,undefined,NaN])assert.equal(bodyBars(value),1);
 assert.ok(bodyBars(1e9)<=6,'bar count stays bounded for huge thread counts');
 assert.equal(bodyStack(1),0);assert.equal(bodyStack(3),2);assert.equal(bodyStack(400),3);
 for(const value of [null,undefined,NaN])assert.equal(bodyStack(value),0);
 assert.equal(runnableShare(0,8),0);assert.equal(runnableShare(4,8),.5);
 assert.equal(runnableShare(99,8),1,'more runnable than threads still clamps');
 for(const pair of [[null,8],[2,null],[2,0]])assert.equal(runnableShare(...pair),0);
});
test('structure survives stale feeds but runnable share does not',()=>{
 const c={...emptyCreature(),group:{name:'w',cpu:.2,rssBytes:1048576,threads:16,count:3,running:8}};
 prepareCreature(c,.016,true);
 assert.ok(c.bars>1);assert.equal(c.stack,2);assert.equal(c.runnable,.5);
 prepareCreature(c,.016,false);
 assert.ok(c.bars>1,'thread count is a fact, not an activity reading');
 assert.equal(c.stack,2);assert.equal(c.runnable,0,'runnable is a live reading and must not persist');
});
test('no bubbles are fabricated for unavailable or idle network traffic',()=>{
 for(const value of [null,undefined,NaN,0,-1])assert.equal(emissionRate(value),0);
 assert.ok(emissionRate(1024)>0);assert.ok(emissionRate(1e20)<=16);
});
