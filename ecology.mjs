export const CAPACITY = 128;
export const measured = value => typeof value === 'number' && Number.isFinite(value);
export const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
export function hash(text) { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; }
export function emptyCreature() { return { x: .5, y: .5, phase: 0, speed: 0, energy: .2, heading: 0, alpha: 0, group: null }; }
export function syncGroups(slots, groups) {
 const incoming = new Map(groups.map(group => [group.name, group]));
 for (const c of slots) {
  if (!c.group) continue;
  c.group = incoming.get(c.group.name) ?? null;
  if (c.group) incoming.delete(c.group.name);
  else { c.speed = 0; c.alpha = 0; }
 }
 for (const group of incoming.values()) {
  const c = slots.find(c => !c.group); if (!c) break;
  const seed = hash(group.name);
  Object.assign(c, emptyCreature(), { group, x: .08 + (seed % 1000) / 1000 * .82, y: .18 + ((seed >>> 12) % 1000) / 1000 * .5, phase: seed % 628 / 100, hue: 145 + seed % 80 });
 }
}
export function activity(cpu) { return measured(cpu) ? clamp(Math.sqrt(Math.max(0, cpu) * 12)) : 0; }
export function prepareCreature(c, dt, fresh) {
 if (!c.group) { c.speed = 0; return; }
 const level = fresh ? activity(c.group.cpu) : 0;
 c.speed = level > 0 ? .004 + level * .085 : 0;
 c.energy = fresh && measured(c.group.cpu) ? .25 + level * .75 : .15;
 c.alpha = Math.min(1, c.alpha + dt * 1.5);
 c.size = 8 + clamp(Math.log2(1 + c.group.rssBytes / 1048576) / 12) * 10;
 c.level = level;
}
// Logarithmic visual rates keep saturated links readable. Zero stays zero.
export function emissionRate(bytes) { return measured(bytes) && bytes > 0 ? Math.min(16, Math.log2(1 + bytes / 1024)) : 0; }
export function stepCreatures(creatures, dt, time) {
 for (const c of creatures) {
  const dx = .5 + Math.sin(time * .09 + c.phase) * .43 - c.x;
  const dy = .48 + Math.cos(time * .12 + c.phase) * .35 - c.y;
  const d = Math.hypot(dx, dy);
  if (!d) continue;
  const step = Math.min(d, c.speed * dt);
  c.x += dx / d * step; c.y += dy / d * step;
  if (step > 0) c.heading = Math.atan2(dy, dx);
 }
}
