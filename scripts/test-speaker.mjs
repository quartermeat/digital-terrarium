#!/usr/bin/env node
// Test fixture for the scene check. Emits the same raw stream parec would
// (s16le, 16 kHz, mono, 50 ms chunks) with loudness driven by a mode file, so
// the check exercises real capture and analysis instead of stubbing the feed.
// Modes: playing (tone), silent (zeros), exit (stop, so capture reports loss).
import { readFileSync } from 'node:fs';

const modePath = process.argv[2];
const RATE = 16000, SAMPLES = 800;
let phase = 0;

setInterval(() => {
  let mode = 'silent';
  try { mode = readFileSync(modePath, 'utf8').trim(); } catch {}
  if (mode === 'exit') process.exit(0);
  const chunk = Buffer.alloc(SAMPLES * 2);
  for (let i = 0; i < SAMPLES; i++) {
    phase += 2 * Math.PI * 180 / RATE;
    chunk.writeInt16LE(Math.round((mode === 'playing' ? Math.sin(phase) * .6 : 0) * 32767), i * 2);
  }
  process.stdout.write(chunk);
}, 50);
