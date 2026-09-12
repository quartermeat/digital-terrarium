import test from 'node:test';
import assert from 'node:assert/strict';
import { visionFresh, handTouchPoints, disturbCreature, faceWireOpacity, aspectScale, correctPoints, NEAR_SPAN, FULL_SPAN } from './vision.mjs';
import { FACE_WIRE_INDICES, FACE_WIRE_EDGES, HAND_WIRE_EDGES } from './vision-topology.mjs';
import { emptyCreature } from './ecology.mjs';

const hand = (x=.5,y=.5) => ({ points: Array.from({length:21},()=>({x,y})), speed:0 });

test('a hand is only present while the camera is still reporting it',()=>{
 const now=Date.now();
 assert.ok(visionFresh({version:1,available:true,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh({version:1,available:true,sampledAt:new Date(now-900).toISOString()},now),'a stopped feed must not leave a phantom hand');
 assert.ok(!visionFresh({version:1,available:false,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh({version:2,available:true,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh(null,now));
 assert.ok(!visionFresh({version:1,available:true,sampledAt:new Date(now+5000).toISOString()},now),'a future stamp is not freshness');
});

test('touch points are the palm and five fingertips, and malformed hands touch nothing',()=>{
 assert.equal(handTouchPoints(hand()).length,6);
 assert.deepEqual(handTouchPoints({points:[]}),[]);
 assert.deepEqual(handTouchPoints(undefined),[]);
});

test('a still hand barely nudges; a sweeping hand shoves, and always outward',()=>{
 const near=()=>Object.assign(emptyCreature(),{x:.52,y:.5});
 const resting=near(),sweeping=near();
 const touches=handTouchPoints(hand());
 const gentle=disturbCreature(resting,touches,.016,0);
 const forceful=disturbCreature(sweeping,touches,.016,3);
 assert.ok(gentle>0&&forceful>gentle*2,'speed must scale the shove');
 assert.ok(sweeping.x>.52,'creatures move away from the hand, never through it');
 const far=Object.assign(emptyCreature(),{x:.95,y:.05});
 assert.equal(disturbCreature(far,touches,.016,3),0,'a hand cannot reach across the habitat');
});

test('a creature pinned exactly under a fingertip still escapes, and stays in the habitat',()=>{
 const trapped=Object.assign(emptyCreature(),{x:.5,y:.5,phase:1});
 disturbCreature(trapped,handTouchPoints(hand()),.05,3);
 assert.ok(Number.isFinite(trapped.x)&&Number.isFinite(trapped.y));
 const edge=Object.assign(emptyCreature(),{x:.5,y:.5});
 for(let i=0;i<400;i++)disturbCreature(edge,handTouchPoints(hand(.5,.5)),.05,3);
 assert.ok(edge.x>=.02&&edge.x<=.98&&edge.y>=.04&&edge.y<=.96,'a shoved creature cannot leave the habitat');
});

test('the face wireframe fades in with proximity instead of snapping on',()=>{
 assert.equal(faceWireOpacity(NEAR_SPAN),0);
 assert.equal(faceWireOpacity(.1),0);
 assert.equal(faceWireOpacity(FULL_SPAN),1);
 assert.equal(faceWireOpacity(.9),1);
 assert.ok(faceWireOpacity((NEAR_SPAN+FULL_SPAN)/2)>0&&faceWireOpacity((NEAR_SPAN+FULL_SPAN)/2)<1);
 assert.equal(faceWireOpacity(undefined),0);
});

test('camera space is narrowed to keep proportions, centred, and survives a missing aspect',()=>{
 const scale=aspectScale(16/9,3440/1440);
 assert.ok(scale<1&&scale>.7);
 assert.equal(aspectScale(undefined,2),1);
 assert.equal(aspectScale(1.78,0),1);
 const [left,centre,right]=correctPoints([{x:0,y:.3},{x:.5,y:.3},{x:1,y:.3}],scale);
 assert.equal(centre.x,.5,'the centre of the camera stays the centre of the habitat');
 assert.ok(left.x>0&&right.x<1,'a wide screen reaches past what the camera can see');
 assert.equal(right.x-centre.x,centre.x-left.x,'correction stays symmetric');
 assert.equal(centre.y,.3,'only width is corrected');
});

test('generated topology indexes only landmarks that are actually transmitted',()=>{
 assert.equal(FACE_WIRE_INDICES.length,136);
 assert.ok(FACE_WIRE_EDGES.every(([a,b])=>a>=0&&b>=0&&a<FACE_WIRE_INDICES.length&&b<FACE_WIRE_INDICES.length));
 assert.ok(HAND_WIRE_EDGES.every(([a,b])=>a>=0&&b>=0&&a<21&&b<21));
});
