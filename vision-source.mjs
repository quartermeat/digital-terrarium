import { FilesetResolver, GestureRecognizer, FaceLandmarker } from '/vendor/tasks-vision/vision_bundle.mjs';
import { FACE_WIRE_INDICES } from './vision-topology.mjs';
import { NEAR_SPAN } from './vision.mjs';

// This page exists only to own the camera. It runs in its own hidden renderer
// so MediaPipe inference never competes with the habitat's frame budget; the
// results reach the scene as one more feed on /api/stream.
const video = document.querySelector('video'), state = document.querySelector('#state');
const ACTIVE_INTERVAL = 42, IDLE_INTERVAL = 250, WAKE_WINDOW = 1500;
let recognizer = null, faceLandmarker = null, delegate = 'CPU';
let camera = '', aspect = 16 / 9, lastVideoTime = -1, faceTick = 0, lastSeen = 0;
const palmHistory = new Map();
let previousStamp = 0;

const report = text => { state.textContent = text; };
const round = value => Math.round(value * 1e4) / 1e4;
// The camera is a mirror: moving right on camera must move right on screen.
const mirror = point => ({ x: round(1 - point.x), y: round(point.y) });

async function createTask(factory, vision, options) {
 for (const attempt of ['GPU', 'CPU']) {
  try {
   const task = await factory.createFromOptions(vision, { ...options, baseOptions: { ...options.baseOptions, delegate: attempt } });
   if (attempt === 'GPU') delegate = 'GPU';
   return task;
  } catch (error) {
   if (attempt === 'CPU') throw error;
   console.warn('GPU vision delegate unavailable; retrying on CPU', error);
  }
 }
}

async function loadModels() {
 const vision = await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
 recognizer = await createTask(GestureRecognizer, vision, {
  baseOptions: { modelAssetPath: '/api/vision-model?name=gesture' },
  runningMode: 'VIDEO', numHands: 2,
  minHandDetectionConfidence: .55, minHandPresenceConfidence: .55, minTrackingConfidence: .55,
 });
 try {
  faceLandmarker = await createTask(FaceLandmarker, vision, {
   baseOptions: { modelAssetPath: '/api/vision-model?name=face' },
   runningMode: 'VIDEO', numFaces: 1,
   minFaceDetectionConfidence: .5, minFacePresenceConfidence: .5, minTrackingConfidence: .5,
  });
 } catch (error) {
  // Hands alone are still a complete input; the face wireframe is additive.
  console.warn('Face landmarks could not load; hands only', error);
 }
}

async function startCamera() {
 const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false,
 });
 video.srcObject = stream;
 await video.play();
 const settings = stream.getVideoTracks()[0].getSettings();
 camera = String(settings.label || 'camera').slice(0, 64);
 aspect = settings.width && settings.height ? settings.width / settings.height : 16 / 9;
}

function handSpeed(side, palm, stamp) {
 const previous = palmHistory.get(side);
 palmHistory.set(side, { x: palm.x, y: palm.y, stamp });
 if (!previous) return 0;
 const seconds = (stamp - previous.stamp) / 1000;
 if (seconds <= 0) return 0;
 return Math.min(40, Math.hypot(palm.x - previous.x, palm.y - previous.y) / seconds);
}

function readHands(stamp) {
 const results = recognizer.recognizeForVideo(video, stamp);
 const hands = [];
 (results.landmarks ?? []).forEach((landmarks, index) => {
  if (landmarks.length !== 21) return;
  const points = landmarks.map(mirror);
  // Handedness is reported for the camera image, which is mirrored on screen.
  const raw = results.handedness?.[index]?.[0];
  const side = raw?.categoryName === 'Left' ? 'Right' : raw?.categoryName === 'Right' ? 'Left' : '';
  const palm = { x: (points[0].x + points[9].x) / 2, y: (points[0].y + points[9].y) / 2 };
  hands.push({
   side, score: round(raw?.score ?? 0), speed: round(handSpeed(side || String(index), palm, stamp)),
   gesture: (results.gestures?.[index]?.[0]?.categoryName ?? '').slice(0, 64),
   points,
  });
 });
 for (const key of palmHistory.keys()) if (!hands.some(hand => (hand.side || '') === key)) palmHistory.delete(key);
 return hands;
}

function readFace(stamp) {
 const results = faceLandmarker.detectForVideo(video, stamp);
 const landmarks = results.faceLandmarks?.[0];
 if (!landmarks || landmarks.length <= Math.max(...FACE_WIRE_INDICES)) return null;
 const points = FACE_WIRE_INDICES.map(index => mirror(landmarks[index]));
 const xs = points.map(point => point.x);
 const span = Math.max(...xs) - Math.min(...xs);
 // Slight hysteresis below the reveal threshold keeps the wireframe from
 // flickering for someone sitting right at the edge of close enough.
 if (span < NEAR_SPAN * .85) return null;
 return { score: 1, span: round(Math.min(1, span)), points };
}

async function post(body) {
 try {
  await fetch('/api/vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 } catch (error) { console.warn('Vision feed unavailable', error); }
}

async function tick() {
 const stamp = performance.now();
 let hands = [], face = null;
 // A remote or paused track can hold currentTime still; inferring twice on the
 // same frame wastes the budget and re-reports a position already sent.
 if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
  lastVideoTime = video.currentTime;
  // MediaPipe requires strictly increasing timestamps per task.
  const monotonic = Math.max(stamp, previousStamp + 1);
  previousStamp = monotonic;
  try { hands = readHands(monotonic); } catch (error) { console.warn(error); }
  const near = lastSeen && stamp - lastSeen < WAKE_WINDOW;
  faceTick += 1;
  if (faceLandmarker && faceTick % (near ? 1 : 3) === 0) {
   try { face = readFace(monotonic); } catch (error) { console.warn(error); }
  }
  if (hands.length || face) lastSeen = stamp;
 }
 await post({ version: 1, available: true, camera, aspect: round(aspect), hands, ...(face ? { face } : {}) });
 const awake = lastSeen && stamp - lastSeen < WAKE_WINDOW;
 report(`${delegate} · ${hands.length} hand(s)${face ? ' · face' : ''} · ${awake ? 'active' : 'idle'}`);
 // Idle throttling: full rate only while something is actually in frame.
 setTimeout(tick, awake ? ACTIVE_INTERVAL : IDLE_INTERVAL);
}

try {
 report('loading models');
 await loadModels();
 report('opening camera');
 await startCamera();
 tick();
} catch (error) {
 report('vision unavailable: ' + error.message);
 console.error(error);
 // Tell the bridge the camera is gone rather than letting the last frame age
 // out ambiguously, then keep the page alive so a retry is a reload away.
 await post({ version: 1, available: false, hands: [] });
}
