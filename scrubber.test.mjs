import test from 'node:test';
import assert from 'node:assert/strict';
import { orphanShare, deadConfidence, approachRadius, chooseScrubTarget, stepScrubber, beginStrike, stepStrike, emptyScrubber, moteCount, bloomBurn, bloomLevel, MOTE_CAP, SCRUB_REACH, KILL_CONFIDENCE, MAX_STANDOFF, STRIKE_SECONDS } from './scrubber.mjs';

test('a group rots only by the share of it that is actually dead',()=>{
 assert.equal(orphanShare({name:'factorio',count:2},{factorio:{dead:1}}),.5);
 assert.equal(orphanShare({name:'factorio',count:1},{factorio:{dead:1}}),1);
 assert.equal(orphanShare({name:'factorio',count:2},{}),0,'a living group must never rot');
 assert.equal(orphanShare({name:'factorio',count:2},{factorio:{dead:9}}),1,'more dead than counted still clamps');
 for(const bad of [null,undefined])assert.equal(orphanShare(bad,{factorio:{dead:1}}),0);
 for(const bad of [null,undefined,NaN])assert.equal(orphanShare({name:'f',count:2},{f:{dead:bad}}),0);
});

test('confidence is read from the bridge, never invented by the scene',()=>{
 assert.equal(deadConfidence({name:'a'},{a:{dead:1,confidence:.62}}),.62);
 assert.equal(deadConfidence({name:'a'},{}),0,'an unreported body is not a doubted one');
 for(const bad of [null,undefined,NaN])assert.equal(deadConfidence({name:'a'},{a:{confidence:bad}}),0);
 assert.equal(deadConfidence({name:'a'},{a:{confidence:5}}),1,'a nonsense score still clamps');
});

test('doubt is distance: the killer closes only as the evidence mounts',()=>{
 assert.equal(approachRadius(1),0,'certainty brings it into contact');
 assert.equal(approachRadius(0),MAX_STANDOFF,'no evidence keeps it at arms length');
 assert.ok(approachRadius(.5)<approachRadius(.2),'more evidence, less distance');
 for(const bad of [null,undefined,NaN])assert.equal(approachRadius(bad),MAX_STANDOFF);
});

test('the scrubber picks the deadest body, breaking ties by distance',()=>{
 const scrub={...emptyScrubber(),x:0,y:0};
 const near={x:.1,y:0,group:{name:'a',count:2}}, far={x:.9,y:0,group:{name:'b',count:2}};
 const whole={x:.95,y:0,group:{name:'c',count:1}};
 const rot=c=>({dead:1,confidence:c});
 assert.equal(chooseScrubTarget(scrub,[near,far],{a:rot(.5),b:rot(.5)}).group.name,'a','equal evidence, nearer body');
 assert.equal(chooseScrubTarget(scrub,[near,whole],{a:rot(.5),c:rot(.5)}).group.name,'c','a wholly dead group outranks distance');
 assert.equal(chooseScrubTarget(scrub,[near,far],{a:rot(.4),b:rot(.9)}).group.name,'b','it commits to what it is surest about, not what is nearest');
 assert.equal(chooseScrubTarget(scrub,[near,far],{}),null,'nothing dead, nothing to chase');
 assert.equal(chooseScrubTarget(scrub,[{x:.1,y:.1,group:null}],{a:rot(1)}),null);
});

test('it arrives before it consumes, and leaves when the tank is clean',()=>{
 const scrub={...emptyScrubber(),x:0,y:0,alpha:1};
 const target={x:.5,y:0,group:{name:'a',count:1}};
 let ready=false, guard=0;
 while(!ready&&guard++<2000)ready=stepScrubber(scrub,target,1,.016);
 assert.ok(ready,'certain of the body, it must reach and commit');
 assert.ok(Math.hypot(scrub.x-target.x,scrub.y-target.y)<=SCRUB_REACH);
 assert.equal(scrub.target,'a');
 const before=scrub.alpha;
 stepScrubber(scrub,null,0,.5);
 assert.ok(scrub.alpha<before,'with nothing dead it fades out rather than parking mid-scene');
 assert.equal(scrub.target,null);
});

test('an uncertain body is stalked from a distance, never struck',()=>{
 const scrub={...emptyScrubber(),x:0,y:0,alpha:1};
 const target={x:.9,y:0,group:{name:'a',count:1}};
 const doubt=KILL_CONFIDENCE-.2;
 let struck=false;
 for(let i=0;i<2000;i++)struck=stepScrubber(scrub,target,doubt,.016)||struck;
 assert.equal(struck,false,'below the kill threshold it must never commit');
 const held=Math.hypot(scrub.x-target.x,scrub.y-target.y);
 assert.ok(held>SCRUB_REACH,'it must hold off rather than sit on the body, held '+held);
 assert.ok(Math.abs(held-approachRadius(doubt))<.05,'it should settle near its standoff, at '+held);
 // The same body, now proven: it closes the rest of the way and commits.
 let ready=false, guard=0;
 while(!ready&&guard++<2000)ready=stepScrubber(scrub,target,1,.016);
 assert.ok(ready,'proof must bring it in');
});

test('a strike runs to completion and reports which kind it was',()=>{
 const scrub=emptyScrubber();
 assert.equal(stepStrike(scrub,.1),null,'no strike, no animation');
 beginStrike(scrub,'reclaimed',192);
 assert.equal(scrub.strike.kind,'reclaimed');
 assert.equal(scrub.strike.amount,192);
 const mid=stepStrike(scrub,STRIKE_SECONDS/2);
 assert.ok(mid.t>0&&mid.t<1&&!mid.finished,'it must animate rather than snap');
 const end=stepStrike(scrub,STRIKE_SECONDS);
 assert.equal(end.finished,true);
 assert.equal(end.kind,'reclaimed');
 assert.equal(scrub.strike,null,'and clear itself so the next body gets a fresh one');
 beginStrike(scrub,'salvaged',0);
 assert.equal(scrub.strike.amount,0,'a harvest worth nothing is still a harvest');
});

test('a large sweep draws a bounded number of specks',()=>{
 assert.equal(moteCount(0),0);
 for(const bad of [null,undefined,NaN,-5])assert.equal(moteCount(bad),0);
 assert.equal(moteCount(1),1);
 assert.ok(moteCount(381)<=MOTE_CAP);
 assert.ok(moteCount(100000)<=MOTE_CAP,'a huge mint must not flood the scene');
 assert.ok(moteCount(100)>moteCount(4),'but more reclaimed must still read as more');
});

test('the bloom burns whole motes and never overdraws',()=>{
 assert.deepEqual(bloomBurn(0,100,1),{spend:0,pending:.6});
 assert.deepEqual(bloomBurn(.6,100,1),{spend:1,pending:.19999999999999996});
 assert.equal(bloomBurn(.5,3,1).spend,1,'it can only burn what the balance holds');
 assert.equal(bloomBurn(5,0,1).spend,0,'an empty balance burns nothing');
 assert.equal(bloomBurn(5,-10,1).spend,0,'a nonsense balance burns nothing');
});

test('drift never banks a debt that discharges in one burst',()=>{
 // Thirty seconds of bloom against an empty balance, as happens before the
 // very first scrub ever pays out.
 let pending=0;
 for(let i=0;i<30;i++)pending=bloomBurn(pending,0,1).pending;
 assert.ok(pending<=1,'an empty balance must not accrue an unbounded debt, got '+pending);
 assert.ok(bloomBurn(pending,381,.016).spend<=1,'a fresh balance must not dump on its first frame');
});

test('light is earned, floors at dark, and saturates',()=>{
 assert.equal(bloomLevel(0),0);
 for(const bad of [null,undefined,NaN,-1])assert.equal(bloomLevel(bad),0);
 assert.ok(bloomLevel(100)>.99&&bloomLevel(100)<=1);
 assert.equal(bloomLevel(1e9),1,'saturates rather than overexposing');
 assert.ok(bloomLevel(50)<bloomLevel(100));
});
