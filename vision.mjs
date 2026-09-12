import { clamp } from './ecology.mjs';

// Mirrors visionStaleAfter in vision.go. A hand or face is a position held right
// now, so a feed that stops reporting reads as absent rather than leaving a
// phantom pinned where the camera last saw one.
export const visionFresh = (frame, now = Date.now()) => {
 if (frame?.version !== 1 || !frame.available) return false;
 const age = now - Date.parse(frame.sampledAt);
 return age >= 0 && age < 500;
};

// Camera space is 16:9 and the habitat is as wide as the desktop, so painting
// one onto the other unchanged would stretch every hand and face sideways.
// Scaling x about the centre keeps proportions true; the cost is that the outer
// margin of a very wide screen sits outside camera reach, which is honest — the
// camera genuinely cannot see there.
export function aspectScale(frameAspect, screenAspect) {
 return Number.isFinite(frameAspect) && frameAspect > 0 && Number.isFinite(screenAspect) && screenAspect > 0
  ? frameAspect / screenAspect : 1;
}
export const correctPoints = (points, scale) => points.map(point => ({ x: .5 + (point.x - .5) * scale, y: point.y }));

// Palm centre and the five fingertips are what the habitat can actually be
// touched by; the remaining landmarks only draw the wireframe.
const FINGERTIPS = [4, 8, 12, 16, 20];
export function handTouchPoints(hand) {
 const points = hand?.points;
 if (!Array.isArray(points) || points.length !== 21) return [];
 const palm = { x: (points[0].x + points[9].x) / 2, y: (points[0].y + points[9].y) / 2, radius: .11 };
 return [palm, ...FINGERTIPS.map(index => ({ x: points[index].x, y: points[index].y, radius: .05 }))];
}

// A hand resting in frame should not bulldoze the habitat; a hand sweeping
// through it should. Speed scales the shove, presence alone barely nudges.
export function disturbCreature(creature, touches, dt, speed = 0) {
 let moved = 0;
 const force = .35 + clamp(speed, 0, 3) * 1.9;
 for (const touch of touches) {
  const dx = creature.x - touch.x, dy = creature.y - touch.y;
  const distance = Math.hypot(dx, dy);
  if (distance >= touch.radius) continue;
  const push = (1 - distance / touch.radius) * force * dt;
  // A creature caught exactly under a fingertip still has to leave somewhere.
  const angle = distance > 1e-6 ? Math.atan2(dy, dx) : creature.phase;
  creature.x += Math.cos(angle) * push;
  creature.y += Math.sin(angle) * push;
  moved += push;
 }
 if (moved > 0) { creature.x = clamp(creature.x, .02, .98); creature.y = clamp(creature.y, .04, .96); }
 return moved;
}

// The face wireframe is a reward for leaning in: it fades up with the measured
// face width so it arrives gradually instead of snapping on at a threshold.
// Measured on this workstation: an ordinary seated distance reads .22, and a
// deliberate lean toward the camera reaches .33. The reveal starts above the
// resting width, so shifting in the chair cannot summon a face, and reaches
// full at a lean that is actually comfortable to hold.
export const NEAR_SPAN = .25, FULL_SPAN = .32;
export function faceWireOpacity(span) {
 if (!Number.isFinite(span) || span <= NEAR_SPAN) return 0;
 return clamp((span - NEAR_SPAN) / (FULL_SPAN - NEAR_SPAN));
}
