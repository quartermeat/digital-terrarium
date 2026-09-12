import test from 'node:test';
import assert from 'node:assert/strict';
import { visionFresh, faceWireOpacity, aspectScale, correctPoints, centroid, greyHead, alienEye, NEAR_SPAN, FULL_SPAN } from './vision.mjs';
import { FACE_WIRE_INDICES, FACE_EDGES, FACE_RINGS } from './vision-topology.mjs';

test('a head is only present while the camera is still reporting it',()=>{
 const now=Date.now();
 assert.ok(visionFresh({version:1,available:true,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh({version:1,available:true,sampledAt:new Date(now-900).toISOString()},now),'a stopped feed must not leave a phantom head');
 assert.ok(!visionFresh({version:1,available:false,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh({version:2,available:true,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh(null,now));
 assert.ok(!visionFresh({version:1,available:true,sampledAt:new Date(now+5000).toISOString()},now),'a future stamp is not freshness');
});

test('the head fades in with proximity instead of snapping on',()=>{
 assert.equal(faceWireOpacity(NEAR_SPAN),0);
 assert.equal(faceWireOpacity(.1),0);
 assert.equal(faceWireOpacity(FULL_SPAN),1);
 assert.equal(faceWireOpacity(.9),1);
 const middle=faceWireOpacity((NEAR_SPAN+FULL_SPAN)/2);
 assert.ok(middle>0&&middle<1);
 assert.equal(faceWireOpacity(undefined),0);
 // Calibrated against live measurement: resting .22 shows nothing, a lean fills.
 assert.equal(faceWireOpacity(.22),0);
 assert.equal(faceWireOpacity(.33),1);
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

test('the head is derived from the face, not traced from it',()=>{
 // A human oval: widest at the cheeks, jaw as broad as the brow.
 const oval=Array.from({length:24},(_,i)=>{
  const angle=i/24*Math.PI*2;
  return {x:Math.cos(angle)*50,y:Math.sin(angle)*70+70};
 });
 const head=greyHead(oval);
 assert.ok(head.length>24);
 const xs=head.map(point=>point.x),ys=head.map(point=>point.y);
 assert.ok(Math.min(...ys)<Math.min(...oval.map(point=>point.y)),'the cranium carries above the face');
 assert.ok(Math.max(...xs)-Math.min(...xs)>100,'and is wider than the face it came from');
 assert.ok(Math.max(...ys)<Math.max(...oval.map(point=>point.y)),'the chin rises: a grey has little face below the eyes');
 // Mostly cranium: more head sits above the widest line than below it, which is
 // the reverse of the human oval it was derived from.
 const top=Math.min(...ys),bottom=Math.max(...ys);
 const widest=head.reduce((best,point)=>Math.abs(point.x)>Math.abs(best.x)?point:best);
 assert.ok(widest.y-top>bottom-widest.y,'the cranium outweighs the face below it');
 const ovalYs=oval.map(point=>point.y);
 const ovalWidest=oval.reduce((best,point)=>Math.abs(point.x)>Math.abs(best.x)?point:best);
 assert.ok(ovalWidest.y-Math.min(...ovalYs)<Math.max(...ovalYs)-ovalWidest.y
  ||widest.y-top>bottom-widest.y,'the proportion is inverted from the face');
 // The chin is a small rounded point, not a spade: few points sit near it.
 const nearChin=head.filter(point=>point.y>bottom-(bottom-top)*.04);
 assert.ok(nearChin.length>=2&&Math.max(...nearChin.map(point=>Math.abs(point.x)))<20,'the chin tapers small');
 assert.deepEqual(greyHead([]),[]);
 assert.deepEqual(greyHead(oval,2),[],'too few samples cannot describe a head');
 assert.deepEqual(greyHead([{x:5,y:0},{x:5,y:9}]),[],'a face with no width is no head');
});

test('the eye is a lopsided teardrop that slants up and out, and mirrors',()=>{
 const centre={x:0,y:0};
 const right=alienEye(centre,100,40,.42,1);
 assert.ok(right.length>=10);
 const outer=right.reduce((best,point)=>point.x>best.x?point:best);
 const inner=right.reduce((best,point)=>point.x<best.x?point:best);
 assert.ok(outer.y<inner.y,'the outer corner rides higher than the inner one');
 // Deepest toward the outer third, pointed at both ends.
 const depthNear=x=>{
  const near=right.filter(point=>Math.abs(point.x-x)<8);
  return near.length?Math.max(...near.map(p=>p.y))-Math.min(...near.map(p=>p.y)):0;
 };
 assert.ok(depthNear(20)>depthNear(-20),'the teardrop is fattest outward');
 assert.ok(depthNear(outer.x)<depthNear(20)&&depthNear(inner.x)<depthNear(20),'both corners come to a point');
 const left=alienEye(centre,100,40,.42,-1);
 const leftOuter=left.reduce((best,point)=>point.x<best.x?point:best);
 assert.ok(Math.abs(leftOuter.x+outer.x)<1e-9&&Math.abs(leftOuter.y-outer.y)<1e-9,'the other eye is a mirror image');
 assert.deepEqual(alienEye(centre,0,40,.4,1),[]);
 assert.deepEqual(alienEye(centre,100,0,.4,1),[]);
});

test('generated topology indexes only landmarks that are actually transmitted',()=>{
 assert.equal(FACE_WIRE_INDICES.length,68,'only the parts the head is built from travel');
 const within=([a,b])=>a>=0&&b>=0&&a<FACE_WIRE_INDICES.length&&b<FACE_WIRE_INDICES.length;
 for(const [name,edges] of Object.entries(FACE_EDGES)) assert.ok(edges.every(within),name+' edges stay in range');
 for(const [name,loops] of Object.entries(FACE_RINGS))
  for(const loop of loops) assert.ok(loop.every(index=>index>=0&&index<FACE_WIRE_INDICES.length),name+' ring stays in range');
 // The head needs the face oval's extent and both eye positions, nothing else.
 assert.equal(FACE_RINGS.cranium[0].length,36);
 assert.equal(FACE_RINGS.leftEye[0].length,16);
 assert.equal(FACE_RINGS.rightEye[0].length,16);
 assert.deepEqual(Object.keys(FACE_RINGS).sort(),['cranium','leftEye','rightEye'],
  'brows, lips and irises are measured by the model but never drawn');
});
