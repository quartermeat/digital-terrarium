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

const quadratic = (from, control, to, t) => ({
 x: (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * control.x + t * t * to.x,
 y: (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * control.y + t * t * to.y,
});

// The face oval measures skin over a human skull: widest at the cheeks, with a
// jaw as broad as the brow. A grey is the other way round — a cranium that
// carries far above the eyes and is widest above them, tapering to a small
// pointed chin — so the head is derived from the oval's extent rather than
// traced from it. Runs left temple, over the vault, down to the chin and back.
export function greyHead(ring, samples = 30) {
 if (!ring?.length || samples < 4) return [];
 const xs = ring.map(point => point.x), ys = ring.map(point => point.y);
 const left = Math.min(...xs), right = Math.max(...xs);
 const top = Math.min(...ys), bottom = Math.max(...ys);
 const half = (right - left) / 2, middle = (left + right) / 2;
 if (!(half > 0) || !(bottom > top)) return [];
 const widest = top + (bottom - top) * .34, wide = half * 1.2;
 const rise = widest - top + half * 1.3;
 // A grey is nearly all cranium: the face below the eyes is short, and the chin
 // is a small rounded point rather than the spade a single apex would give.
 const chinY = widest + (bottom - widest) * .82, chinHalf = wide * .1;
 const dome = Array.from({ length: samples + 1 }, (_, index) => {
  const angle = Math.PI * index / samples;
  return { x: middle - Math.cos(angle) * wide, y: widest - Math.sin(angle) * rise };
 });
 const drop = chinY - widest, jawSamples = Math.max(3, Math.round(samples / 2));
 const temple = direction => ({ x: middle + wide * direction, y: widest });
 const chin = direction => ({ x: middle + chinHalf * direction, y: chinY });
 const control = direction => ({ x: middle + wide * .7 * direction, y: widest + drop * .68 });
 const taper = (from, to, direction) => Array.from({ length: jawSamples },
  (_, index) => quadratic(from, control(direction), to, (index + 1) / jawSamples));
 return [...dome, ...taper(temple(1), chin(1), 1), ...taper(chin(-1), temple(-1), -1)];
}

// The signature feature: a large teardrop slanting up and out, pointed at the
// inner corner and deepest toward the outer third. A symmetric lens reads as a
// cartoon eye, so the profile is deliberately lopsided.
export function alienEye(centre, length, height, tilt, outward = 1, samples = 26) {
 if (!(length > 0) || !(height > 0) || samples < 4) return [];
 const half = length / 2, cos = Math.cos(-tilt), sin = Math.sin(-tilt);
 const place = (along, across) => {
  const x = along * half, y = across;
  return { x: centre.x + (x * cos - y * sin) * outward, y: centre.y + (x * sin + y * cos) };
 };
 const profile = along => Math.sqrt(Math.max(0, 1 - along * along)) * (.5 + .25 * (along + 1));
 const top = [], bottom = [];
 for (let index = 0; index <= samples; index += 1) {
  const along = -1 + 2 * index / samples, reach = height / 2 * profile(along);
  top.push(place(along, -reach));
  bottom.push(place(along, reach));
 }
 return [...top, ...bottom.reverse()];
}
