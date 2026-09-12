import test from 'node:test';
import assert from 'node:assert/strict';
import { visionFresh, faceWireOpacity, aspectScale, correctPoints, centroid, expandRing, roundRing, toothBand, nasalCavity, cranialDome, skullSilhouette, NEAR_SPAN, FULL_SPAN } from './vision.mjs';
import { FACE_WIRE_INDICES, FACE_EDGES, FACE_RINGS } from './vision-topology.mjs';

test('a skull is only present while the camera is still reporting it',()=>{
 const now=Date.now();
 assert.ok(visionFresh({version:1,available:true,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh({version:1,available:true,sampledAt:new Date(now-900).toISOString()},now),'a stopped feed must not leave a phantom skull');
 assert.ok(!visionFresh({version:1,available:false,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh({version:2,available:true,sampledAt:new Date(now).toISOString()},now));
 assert.ok(!visionFresh(null,now));
 assert.ok(!visionFresh({version:1,available:true,sampledAt:new Date(now+5000).toISOString()},now),'a future stamp is not freshness');
});

test('the skull fades in with proximity instead of snapping on',()=>{
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

test('a lid contour opens outward into a socket, keeping its centre',()=>{
 const lid=[{x:10,y:0},{x:0,y:10},{x:-10,y:0},{x:0,y:-10}];
 const middle=centroid(lid);
 assert.deepEqual(middle,{x:0,y:0});
 const socket=expandRing(lid,1.55);
 assert.deepEqual(centroid(socket),middle,'a socket stays centred on the eye it came from');
 assert.ok(socket.every((point,i)=>Math.hypot(point.x,point.y)>Math.hypot(lid[i].x,lid[i].y)),'bone sits outside the lid');
 assert.deepEqual(centroid([]),{x:0,y:0});
});

test('an almond lid is pulled toward a round hollow without moving off the eye',()=>{
 const lid=[{x:20,y:0},{x:0,y:5},{x:-20,y:0},{x:0,y:-5}];
 const round=roundRing(lid,1);
 const radii=round.map(point=>Math.hypot(point.x,point.y));
 assert.ok(Math.max(...radii)-Math.min(...radii)<1e-9,'full roundness gives one radius');
 const middle=centroid(round);
 assert.ok(Math.abs(middle.x)<1e-9&&Math.abs(middle.y)<1e-9,'the hollow stays on the eye');
 const partial=roundRing(lid,.5).map(point=>Math.hypot(point.x,point.y));
 assert.ok(Math.max(...partial)<20&&Math.min(...partial)>5,'partial roundness lands between lid and circle');
 assert.deepEqual(roundRing([],1),[]);
 assert.deepEqual(roundRing(lid,0).map(p=>Math.round(Math.hypot(p.x,p.y))),[20,5,20,5],'no roundness leaves the lid alone');
});

test('teeth are a band of bone, wider and shorter than the lips covering them',()=>{
 const mouth=[{x:0,y:0},{x:10,y:-4},{x:20,y:0},{x:20,y:1},{x:10,y:6},{x:0,y:1}];
 const band=toothBand(mouth,9);
 assert.equal(band.bars.length,8,'nine teeth are divided by eight seams');
 assert.ok(band.left<0&&band.right>20,'the jaw is broader than the mouth over it');
 assert.ok(band.top>-4&&band.bottom<6,'the band is drawn back from the full lip height');
 assert.ok(band.midline>band.top&&band.midline<band.bottom,'the jaws part inside the band');
 assert.ok(band.bars.every(x=>x>band.left&&x<band.right),'no seam falls outside the band');
 assert.equal(toothBand(mouth,0),null);
 assert.equal(toothBand([],9),null);
 assert.equal(toothBand([{x:5,y:0},{x:5,y:4}],9),null,'a band with no width is no band');
});

test('the cranial vault springs from the brow and closes the jaw into one outline',()=>{
 const ring=Array.from({length:24},(_,i)=>{
  const angle=i/24*Math.PI*2;
  return {x:Math.cos(angle)*50,y:Math.sin(angle)*70+40};
 });
 const browY=-10;
 const dome=cranialDome(ring,browY);
 assert.ok(dome.length>=3);
 assert.ok(Math.min(...dome.map(point=>point.y))<browY,'the vault rises above the brow');
 assert.ok(dome.every(point=>point.y<=browY+1e-9),'the vault never dips below the brow line');
 assert.ok(Math.abs(dome[0].x+50)<1e-6&&Math.abs(dome[dome.length-1].x-50)<1e-6,'it runs temple to temple');
 const outline=skullSilhouette(ring,browY);
 assert.ok(outline.length>dome.length,'the jaw is carried on past the vault');
 const bottom=Math.max(...ring.map(point=>point.y));
 assert.ok(Math.max(...outline.map(point=>point.y))===bottom,'the chin survives into the outline');
 assert.deepEqual(cranialDome([],0),[]);
 assert.deepEqual(skullSilhouette([],0),[]);
});

test('the nasal aperture hangs between the sockets and stops above the teeth',()=>{
 const nose=nasalCavity({x:-20,y:0},{x:20,y:0},60);
 assert.ok(nose.length>=5);
 const ys=nose.map(point=>point.y),xs=nose.map(point=>point.x);
 assert.ok(Math.min(...ys)>0&&Math.max(...ys)<60,'the aperture sits between bridge and teeth');
 assert.ok(Math.min(...xs)>-20&&Math.max(...xs)<20,'the aperture stays inside the sockets');
 assert.deepEqual(nasalCavity({x:-20,y:80},{x:20,y:80},60),[],'teeth above the bridge yield no aperture');
});

test('generated topology indexes only landmarks that are actually transmitted',()=>{
 assert.equal(FACE_WIRE_INDICES.length,136);
 const within=([a,b])=>a>=0&&b>=0&&a<FACE_WIRE_INDICES.length&&b<FACE_WIRE_INDICES.length;
 for(const [name,edges] of Object.entries(FACE_EDGES)) assert.ok(edges.every(within),name+' edges stay in range');
 for(const [name,loops] of Object.entries(FACE_RINGS))
  for(const loop of loops) assert.ok(loop.every(index=>index>=0&&index<FACE_WIRE_INDICES.length),name+' ring stays in range');
 // The skull needs these specific closed loops to fill bone, sockets and mouth.
 assert.equal(FACE_RINGS.cranium[0].length,36);
 assert.equal(FACE_RINGS.leftEye[0].length,16);
 assert.equal(FACE_RINGS.rightEye[0].length,16);
 assert.equal(FACE_RINGS.mouth.length,2,'an outer and an inner lip ring');
 assert.ok(FACE_RINGS.mouth[0].length>=FACE_RINGS.mouth[1].length,'the outer ring comes first');
 assert.ok(FACE_EDGES.leftBrow.length&&FACE_EDGES.rightBrow.length,'brows still seat the sockets and the vault');
 assert.equal(FACE_RINGS.leftIris[0].length,4);
});
