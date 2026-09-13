import { clamp, measured } from './ecology.mjs';

// A creature is a group of processes sharing a name, so death arrives by
// fraction rather than all at once: the same "factorio" that hosts a live save
// also hosted the one nobody owns any more. The share that is dead is what
// rots, which keeps the body honest -- a half-orphaned group is half-lit, not
// condemned outright.
export function orphanShare(group, groups) {
 if(!group||!groups)return 0;
 const dead=groups[group.name]?.dead;
 if(!measured(dead)||dead<=0)return 0;
 const count=measured(group.count)&&group.count>0?group.count:1;
 return clamp(dead/count);
}

// How sure the bridge is that this body is abandoned, assembled there from
// named evidence. The scene never computes it -- it only decides how close that
// certainty lets the killer come.
export function deadConfidence(group, groups) {
 const confidence=group&&groups?groups[group.name]?.confidence:0;
 return measured(confidence)?clamp(confidence):0;
}

// Mirrors scrubThreshold in scrubber.go: below this the killer may look but
// never strike.
export const KILL_CONFIDENCE = .85;
export const MAX_STANDOFF = .22;

// Doubt is drawn as distance. At no confidence the killer hangs right back at
// the edge of its reach; as evidence accumulates it closes, and only certainty
// brings it into contact. Watching it drift inward is watching the bridge make
// up its mind.
export function approachRadius(confidence) {
 return (1-(measured(confidence)?clamp(confidence):0))*MAX_STANDOFF;
}

export const SCRUB_REACH = .035;
export const SCRUB_SPEED = .28;

export function emptyScrubber() { return { x:.5, y:.08, alpha:0, phase:0, target:null, confidence:0, strike:null }; }

// The scrubber goes to the most thoroughly dead body first, and breaks ties by
// distance so it does not cross the tank past a corpse it could already reach.
export function chooseScrubTarget(scrub, creatures, groups) {
 let best=null, bestKey=null;
 for(const c of creatures) {
  if(!c.group)continue;
  const share=orphanShare(c.group,groups);
  if(share<=0)continue;
  // Certainty first, then how much of the body is gone, then distance: the
  // killer commits to what it is surest about rather than what is nearest.
  const key=[-deadConfidence(c.group,groups),-share,Math.hypot(c.x-scrub.x,c.y-scrub.y)];
  if(!bestKey||key.some((v,i)=>v!==bestKey[i]&&v<bestKey[i]&&key.slice(0,i).every((w,j)=>w===bestKey[j]))){best=c;bestKey=key;}
 }
 return best;
}

// Returns true on the frame it arrives, which is the frame the corpse is
// consumed. Without a target it rises out of the scene rather than parking in
// the middle of it.
// Returns true only on the frame it is both in contact and sure enough to act.
// Short of that it still closes to its standoff and waits there, which is what
// makes an uncertain body visibly stalked rather than quietly ignored.
export function stepScrubber(scrub, target, confidence, dt) {
 scrub.phase+=dt*6;
 if(!target){
  scrub.target=null; scrub.confidence=0;
  scrub.alpha=Math.max(0,scrub.alpha-dt*1.2);
  scrub.y+=(.08-scrub.y)*Math.min(1,dt*2);
  return false;
 }
 scrub.target=target.group?target.group.name:null;
 scrub.confidence=measured(confidence)?clamp(confidence):0;
 scrub.alpha=Math.min(1,scrub.alpha+dt*2);
 const standoff=approachRadius(scrub.confidence);
 const dx=target.x-scrub.x, dy=target.y-scrub.y, d=Math.hypot(dx,dy);
 if(!d)return scrub.confidence>=KILL_CONFIDENCE;
 const close=d-standoff;
 if(close>SCRUB_REACH){
  const step=Math.min(close,SCRUB_SPEED*dt);
  scrub.x+=dx/d*step; scrub.y+=dy/d*step;
  return false;
 }
 // On station: circle the body rather than sitting on it.
 const tangent=Math.atan2(dy,dx)+Math.PI/2;
 scrub.x+=Math.cos(tangent)*dt*.05; scrub.y+=Math.sin(tangent)*dt*.05;
 return scrub.confidence>=KILL_CONFIDENCE;
}

// Two ways to be paid, and they are not the same act. RECLAIM is a kill: the
// killer takes memory that was still held and the motes are minted from what
// the machine got back. SALVAGE is free currency -- the body already exited on
// its own, and what is left is only the residue of memory nobody had to take.
export const STRIKE_SECONDS = .9;
export function beginStrike(scrub, kind, amount) {
 scrub.strike={ kind, amount:measured(amount)&&amount>0?amount:0, t:0 };
 return scrub.strike;
}
export function stepStrike(scrub, dt) {
 if(!scrub.strike)return null;
 scrub.strike.t+=dt/STRIKE_SECONDS;
 if(scrub.strike.t>=1){const finished=scrub.strike;scrub.strike=null;return {...finished,t:1,finished:true};}
 return scrub.strike;
}

// Motes are minted by the bridge against measured reclaimed memory; the scene
// only decides how many specks to draw for them. A sweep worth hundreds of
// mebibytes must not spawn hundreds of particles.
export const MOTE_CAP = 24;
export function moteCount(amount) {
 return measured(amount)&&amount>0?Math.max(1,Math.min(MOTE_CAP,Math.round(Math.sqrt(amount)))):0;
}

// The habitat burns motes to stay lit, so a balance that is never replenished
// fades on its own and scrubbing is what keeps the tank bright. Spending is
// asked for in whole motes; fractions accumulate between frames.
export const BLOOM_RATE = .6;
export function bloomBurn(pending, balance, dt) {
 const wanted=pending+BLOOM_RATE*dt;
 const whole=Math.floor(Math.min(wanted,Math.max(0,balance)));
 // Unspent drift may never bank more than a single mote. Without the cap a
 // long spell at an empty balance accrues a debt that discharges in one burst
 // the instant a scrub pays out, and the first thing a fresh balance does is
 // dump a chunk of itself.
 return { spend: whole, pending: Math.min(whole>0?wanted-whole:wanted,1) };
}

// Light the scene earns rather than fakes: full bloom at a hundred motes, and
// an unscrubbed machine settles to a floor instead of going black.
export function bloomLevel(balance) {
 return measured(balance)&&balance>0?clamp(Math.log2(1+balance)/Math.log2(101)):0;
}
