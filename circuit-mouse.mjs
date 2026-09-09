// Movement is measured in normalized habitat coordinates; timers use seconds.
export function advanceMouse(mouse, dx, dy, dt, time) {
 mouse.nibble = Math.max(0, (mouse.nibble ?? 0) - dt);
 const scanning = Math.sin(time * 2.1 + mouse.phase) > .65;
 mouse.activity = mouse.nibble > 0 ? 'nibbling' : scanning ? 'scanning' : 'scurrying';
 const distance = Math.hypot(dx, dy);
 const speed = mouse.activity === 'scurrying' ? mouse.speed * 1.65 : 0;
 const step = Math.min(distance, speed * dt);
 if (distance > 0) {
  mouse.x += dx / distance * step;
  mouse.y += dy / distance * step;
  const target = Math.atan2(dy, dx);
  const delta = Math.atan2(Math.sin(target - (mouse.heading ?? target)), Math.cos(target - (mouse.heading ?? target)));
  mouse.heading = (mouse.heading ?? target) + delta * Math.min(1, dt * 9);
 }
 return step;
}
