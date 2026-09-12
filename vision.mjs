import { clamp } from './ecology.mjs';

// Mirrors visionStaleAfter in vision.go. A face is a position held right now, so
// a feed that stops reporting reads as absent rather than leaving a phantom
// skull pinned where the camera last saw one.
export const visionFresh = (frame, now = Date.now()) => {
 if (frame?.version !== 1 || !frame.available) return false;
 const age = now - Date.parse(frame.sampledAt);
 return age >= 0 && age < 500;
};

// Camera space is 16:9 and the habitat is as wide as the desktop, so painting
// one onto the other unchanged would stretch the skull sideways. Scaling x about
// the centre keeps it in proportion; the cost is that the outer margin of a very
// wide screen sits outside camera reach, which is honest — the camera genuinely
// cannot see there.
export function aspectScale(frameAspect, screenAspect) {
 return Number.isFinite(frameAspect) && frameAspect > 0 && Number.isFinite(screenAspect) && screenAspect > 0
  ? frameAspect / screenAspect : 1;
}
export const correctPoints = (points, scale) => points.map(point => ({ x: .5 + (point.x - .5) * scale, y: point.y }));

// The skull is a reward for leaning in: it fades up with the measured face width
// rather than snapping on, so approaching the camera feels continuous. Measured
// live on this workstation, an ordinary seated distance reads .22 and a
// deliberate lean reaches .33. The reveal starts above the resting width, so
// shifting in the chair cannot summon a skull, and reaches full at a lean that
// is comfortable to hold.
export const NEAR_SPAN = .25, FULL_SPAN = .32;
export function faceWireOpacity(span) {
 if (!Number.isFinite(span) || span <= NEAR_SPAN) return 0;
 return clamp((span - NEAR_SPAN) / (FULL_SPAN - NEAR_SPAN));
}

export function centroid(points) {
 if (!points?.length) return { x: 0, y: 0 };
 return {
  x: points.reduce((total, point) => total + point.x, 0) / points.length,
  y: points.reduce((total, point) => total + point.y, 0) / points.length,
 };
}

// Eye contours trace the lid, which is far tighter than the bone around it.
// Pushing the ring outward from its own centre turns an eye into a socket.
export function expandRing(points, factor, about = centroid(points)) {
 return points.map(point => ({ x: about.x + (point.x - about.x) * factor, y: about.y + (point.y - about.y) * factor }));
}

// An expanded lid is still lid-shaped, and an almond hole reads as an eye no
// matter how brightly it is drawn. Pulling the ring toward a circle of its own
// mean radius gives the blunt, rounded hollow that reads as bone.
export function roundRing(points, roundness, about = centroid(points)) {
 if (!points?.length) return [];
 const polar = points.map(point => {
  const dx = point.x - about.x, dy = point.y - about.y;
  return { angle: Math.atan2(dy, dx), radius: Math.hypot(dx, dy) };
 });
 const mean = polar.reduce((total, point) => total + point.radius, 0) / polar.length;
 const blend = clamp(roundness);
 return polar.map(({ angle, radius }) => {
  const mixed = radius + (mean - radius) * blend;
  return { x: about.x + Math.cos(angle) * mixed, y: about.y + Math.sin(angle) * mixed };
 });
}

// Teeth are a straight band of bone, not a lip line, so the band is derived from
// the mouth region's extent rather than from its contour. Widening past the lips
// is deliberate: a jaw is broader than the mouth that covers it.
export function toothBand(points, count, widen = 1.12, shorten = .78) {
 if (!points?.length || count < 1) return null;
 const xs = points.map(point => point.x), ys = points.map(point => point.y);
 const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
 const half = (Math.max(...xs) - Math.min(...xs)) / 2 * widen;
 // Lips are taller than the teeth behind them, so the band is drawn back
 // toward its own centre line rather than filling the whole mouth.
 const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
 const reach = (Math.max(...ys) - Math.min(...ys)) / 2 * shorten;
 const top = centreY - reach, bottom = centreY + reach;
 if (!(half > 0) || !(bottom > top)) return null;
 return {
  left: middle - half, right: middle + half, top, bottom, midline: (top + bottom) / 2,
  // Interior divisions only: the band's own edges are drawn as its outline.
  bars: Array.from({ length: count - 1 }, (_, index) => middle - half + half * 2 * (index + 1) / count),
 };
}

// The face oval stops at the hairline, which is skin: it gives a flat-topped
// slab rather than a cranium. The vault is sprung from the brow line and carried
// higher and rounder than the oval ever goes, which is what separates a skull
// from a mask. Runs left temple to right temple.
export function cranialDome(ring, browY, samples = 26) {
 if (!ring?.length || samples < 3) return [];
 const xs = ring.map(point => point.x);
 const left = Math.min(...xs), right = Math.max(...xs), half = (right - left) / 2;
 if (!(half > 0)) return [];
 const middle = (left + right) / 2, rise = half * 1.12;
 return Array.from({ length: samples }, (_, index) => {
  const angle = Math.PI * index / (samples - 1);
  return { x: middle - Math.cos(angle) * half, y: browY - Math.sin(angle) * rise };
 });
}

// One closed outline for the whole skull: the derived vault over the top, then
// the measured jaw of the face oval back around the bottom. Filling one path
// keeps the bone solid instead of showing a seam where the two meet.
export function skullSilhouette(ring, browY, samples = 26) {
 const dome = cranialDome(ring, browY, samples);
 if (!dome.length) return [];
 let leftIndex = 0, rightIndex = 0, bottomIndex = 0;
 ring.forEach((point, index) => {
  if (point.x < ring[leftIndex].x) leftIndex = index;
  if (point.x > ring[rightIndex].x) rightIndex = index;
  if (point.y > ring[bottomIndex].y) bottomIndex = index;
 });
 const walk = step => {
  const path = [];
  for (let index = rightIndex; ; index = (index + step + ring.length) % ring.length) {
   path.push(index);
   if (index === leftIndex || path.length > ring.length) break;
  }
  return path;
 };
 // Whichever way round the ring passes the chin is the jaw; the other way is
 // the forehead the vault has already replaced.
 const forward = walk(1);
 const jaw = forward.includes(bottomIndex) ? forward : walk(-1);
 return [...dome, ...jaw.map(index => ring[index])];
}

// The mesh has no nasal aperture, so it is derived: an inverted heart hanging
// between the sockets, narrow at the bridge and flaring toward the teeth, the
// way it sits on a real skull. Derived geometry keeps this correct for any face.
export function nasalCavity(leftEye, rightEye, teethTop) {
 const bridge = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
 const drop = teethTop - bridge.y;
 if (!(drop > 0)) return [];
 const half = Math.abs(rightEye.x - leftEye.x) * .27;
 const base = bridge.y + drop * .72;
 // Apex a third of the way down, so the aperture sits below the brow line and
 // stops clear of the teeth rather than running into them.
 return [
  { x: bridge.x, y: bridge.y + drop * .3 },
  { x: bridge.x + half * .42, y: bridge.y + drop * .6 },
  { x: bridge.x + half, y: base },
  { x: bridge.x + half * .3, y: base + drop * .07 },
  { x: bridge.x, y: base - drop * .04 },
  { x: bridge.x - half * .3, y: base + drop * .07 },
  { x: bridge.x - half, y: base },
  { x: bridge.x - half * .42, y: bridge.y + drop * .6 },
 ];
}
