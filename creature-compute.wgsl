struct Creature {
 x: f32, y: f32, phase: f32, speed: f32,
 energy: f32, nibble: f32, heading: f32, activity: f32,
 target: f32, distance: f32, pad0: f32, pad1: f32,
}
struct Params { dt: f32, time: f32, aquarium: f32, count: f32, packets: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<storage, read_write> creatures: array<Creature>;
@group(0) @binding(1) var<storage, read> food: array<vec2f>;
@group(0) @binding(2) var<uniform> p: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
 let i = id.x;
 if (i >= u32(p.count)) { return; }
 var c = creatures[i];
 var closest = -1.0;
 var distance = 1e10;
 var target = vec2f(.5 + sin(p.time*.09+c.phase)*.43, .77 + sin(p.time*.2+c.phase)*.15);
 if (p.aquarium > .5) { target.y = .48 + cos(p.time*.12+c.phase)*.35; }
 for (var j = 0u; j < u32(p.packets); j++) {
  let d = length(food[j]-vec2f(c.x,c.y));
  if (d < distance) { distance=d; closest=f32(j); target=food[j]; }
 }
 let delta = target-vec2f(c.x,c.y);
 let d = length(delta);
 var speed = c.speed;
 if (p.aquarium < .5) {
  c.nibble = max(0.0,c.nibble-p.dt);
  c.activity = 0.0;
  if (sin(p.time*2.1+c.phase) > .65) { c.activity=1.0; }
  if (c.nibble > 0.0) { c.activity=2.0; }
  speed *= 1.65;
  if (c.activity > .5) { speed=0.0; }
 }
 if (d > 0.0) {
  let position = vec2f(c.x,c.y)+delta/d*min(d,speed*p.dt);
  c.x=position.x; c.y=position.y;
  let heading=atan2(delta.y,delta.x);
  if (p.aquarium > .5) { c.heading=heading; }
  else { c.heading += atan2(sin(heading-c.heading),cos(heading-c.heading))*min(1.0,p.dt*9.0); }
 }
 c.energy=max(.2,c.energy-p.dt*.015);
 c.target=closest; c.distance=distance;
 creatures[i]=c;
}
