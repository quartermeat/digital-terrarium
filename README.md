# Digital Terrarium

An electronic ecology over your selected KDE wallpaper. Creatures, electrolyte,
circuit roots, and bubbles respond to live machine measurements. The desktop
window stays beneath ordinary application windows. There are no permanent labels
or buttons; hover an item to see its meaning and measurements.

## Run

```bash
npm install
npm start
```

The Go bridge has its own address, `127.0.0.1:8091`, separate from webcam_viewer.
Electron checks the bridge identity before using it. `Ctrl+Alt+Q` quits this
Electron instance when the shortcut is available.

Browser preview: `npm run serve`, then open
<http://127.0.0.1:8091/terrarium.html>. The selected wallpaper is drawn into the
canvas every frame in both Electron and browser preview. Restart the app after
changing the wallpaper. The existing KDE image selection is used with a centered
cover crop; slideshows and per-monitor wallpaper selection are not implemented.

## What the ecosystem means

| Visible entity | Machine measurement | Behavior |
| --- | --- | --- |
| Electronic process creature | Current user's processes grouped by Linux command name | Speed and brightness follow CPU activity. Size follows summed RSS. Status bars count doublings of thread count. The ring closes in proportion to the share of those threads that are runnable. Outlines stacked behind the body count the processes sharing the name. Idle groups stop moving. Groups appear/disappear with the sampled process list. |
| Activity sparks | CPU activity of their process group | Brief upward sparks become more frequent as activity rises. |
| Electrolyte pool | RAM usage, memory pressure, swap, speaker audio | Fill and rim color follow RAM usage. Lines ripple with the playing waveform and bass, alongside memory stalls and swap traffic. |
| Circuit root | Mounted local filesystem | Color and height reflect unavailable space. Pulses follow measured block-device reads/writes. |
| Network port | A non-loopback network interface | Cyan bubbles descend for received bytes; amber bubbles rise for transmitted bytes. |

Motion paths and entity placement supply personality. Brightness, movement
activity, size, and emission rates are derived from measurements. Sparks and
bubbles are visual summaries with logarithmic scaling, not literal instructions
or packets. Clicking the scene no longer manufactures telemetry.

CPU is a fraction of the entire machine's CPU capacity, measured between samples.
A process using one core on an eight-core machine therefore reports about 12.5%.
Names are the kernel command names from `/proc/PID/stat`, which can be truncated;
different programs with identical command names share a creature. RSS is summed
across the group and may double-count shared pages. Threads and runnable process
counts are instantaneous samples. Processes that start and exit between samples
may never appear. Exits are not labeled as crashes.

Music waves use `parec` to monitor the desktop's default speaker output, never
the microphone. The bridge analyzes 50 ms chunks in memory and exposes level,
bass energy, and a reduced waveform at `/api/audio`; it does not save audio.
All sound on that output can affect the well. Silence or an unavailable monitor
smoothly removes the music motion. Capture retries after a disconnect. Run the
bridge in the desktop user's audio session (PulseAudio or PipeWire-Pulse).

RAM usage uses `1 - MemAvailable / MemTotal`. Actual memory pressure is PSI
`some avg10`: the fraction of the last ten seconds during which at least one
task was stalled on memory. Swap traffic is separate from swap occupancy.
Filesystem unavailable space includes reserved blocks. Bind mounts on the same
device share a root. Pseudo filesystems and squashfs images are excluded.
Network interfaces are shown separately, avoiding a misleading aggregate across
physical and virtual interfaces. Disk I/O may be unavailable for a filesystem
without directly matching block-device counters.

## Data and compute

Go samples once per second and publishes a cached, read-only snapshot at
`GET /api/ecosystem`. Multiple viewers share the same sampling intervals.

The viewer does not poll. `GET /api/stream` is a Server-Sent Events feed
carrying all three sources over one connection, each pushed at the cadence the
bridge actually samples it: `ecosystem` once per second, `agents` twice per
second, `audio` twenty times per second. That last one is why this exists —
speaker capture produces a frame every 50 ms, and polling for it meant 20 HTTP
round trips per second that could only ever sample the feed rather than follow
it. `GET /api/ecosystem`, `/api/agents` and `/api/audio` remain as one-shot
reads for scripting and inspection.
No commands, environment variables, browser content, network destinations, or
packet contents are collected. Only the current user's process groups are shown;
memory, network, and disk measurements cover the machine.

Missing measurements are null, not zero. The first counter sample establishes a
baseline. Counter resets and PID reuse do not produce activity spikes. When the
feed fails or becomes more than five seconds old, motion/emissions stop and
entities turn gray; hover details identify readings as stale.

The display is bounded to 512 process groups, eight filesystems, six interfaces,
and 160 transient particles. Stable slots preserve process identity when the list
changes. Movement is integrated in JavaScript. Earlier versions ran this step on
WebGPU, then WebGL2 transform feedback; both were removed in v1.4.0 after
measurement, because drawing happens on the CPU and so every frame ended with a
blocking `getBufferSubData` readback to get positions back into JavaScript. That
readback cost 29% of each frame, and the GPU round trip measured slower than the
plain JavaScript integration at every population tested — 20x slower at 128
creatures and still 4.7x slower at 2048.

The default bridge is local-only. Set `TERRARIUM_ADDRESS` consistently for
Electron and Go to change the address. Public assets are explicitly listed;
repository files and the old webcam control endpoints are not served.

## Spotify mood queue

The optional Spotify controller chooses what to queue next from machine activity:

| Mood | Trigger | Playlist role |
| --- | --- | --- |
| `calm` | Light CPU and network activity | Ambient, acoustic, or other quiet music |
| `flow` | Moderate CPU or network activity | Focus music |
| `busy` | CPU at least 45%, or network traffic at least 5 MiB/s | Energetic music |
| `chaotic` | CPU at least 80%, or memory stalls at least 5% | Intense music |

Copy `spotify.example.json` to `spotify.json` in the repository root, add the
client ID from a Spotify developer app, and replace each placeholder with a
playlist you own or collaborate on — Spotify's API rejects reads of playlists
you neither own nor collaborate on, including its own editorial/algorithmic
ones. `spotify.json` is git-tracked: it holds only a PKCE client ID and
playlist IDs, no secrets, so mood-playlist changes get real history and can be
tagged with a release. Symlink it into place:

```bash
ln -s "$(pwd)/spotify.json" ~/.config/digital-terrarium/spotify.json
```

The refresh/access token is a secret and is never part of this — it stays out
of the repo entirely (`.gitignore`d) and lives only in
`~/.config/digital-terrarium/spotify-token.json`, described below. In the
Spotify app settings, register this exact redirect URI:

```text
http://127.0.0.1:8091/api/spotify/callback
```

Restart the terrarium, then open
<http://127.0.0.1:8091/api/spotify/login> once to authorize it. The connector
uses OAuth Authorization Code with PKCE and requests only playback state,
playback control, and private-playlist read access. The refresh token is written
to `~/.config/digital-terrarium/spotify-token.json` with mode `0600`; it is never
served over HTTP. Inspect the controller without exposing credentials:

```bash
curl -fsS http://127.0.0.1:8091/api/spotify/status
```

Every 15 seconds, the controller reads the current Spotify playback state. When
a playing track has 30 seconds or less remaining, it queues one track from the
current mood playlist. It queues at most once for each current track and does
nothing while playback is stopped. Mood selection uses machine telemetry only;
the memory well separately reacts to the desktop's speaker audio.

Set `TERRARIUM_SPOTIFY_START_ON_LAUNCH=true` to start one mood-selected track
when the bridge launches. It waits for authorization and the playback device,
then leaves subsequent pauses alone. `deviceName` in `spotify.json` must match
the computer's name in Spotify (defaults to the machine hostname). It never
falls back to a different device. Status includes `startPending`, `lastStarted`,
and any API error. Playback control requires Spotify Premium.
The workstation desktop-login service supplies this flag; normal previews do not.

Configuration may instead be supplied with `TERRARIUM_SPOTIFY_ENABLED=true`,
`TERRARIUM_SPOTIFY_CLIENT_ID`, and comma-separated `TERRARIUM_SPOTIFY_CALM`, `TERRARIUM_SPOTIFY_FLOW`,
`TERRARIUM_SPOTIFY_BUSY`, and `TERRARIUM_SPOTIFY_CHAOTIC` environment variables.

Measurement reference: [Linux proc documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

## Local agents

Small luminous couriers represent source-neutral local agents. During work they
dart much faster than process creatures, visiting the named target first and then
hopping rapidly among live process beings and filesystem roots. A process target
leads to the matching process creature; a filesystem target leads to the longest
matching mounted root. Green code fragments mark fast travel and active work.
Hover to see the agent, phase, detail, and resolved destination. `thinking`,
`working`, and `tool` describe activity actually in progress, so a report in
one of those phases older than five seconds is dropped rather than kept
animating past what was really sampled. `idle`, `waiting`, and `error`
describe a condition rather than an event — a "waiting for direction" report
stays valid indefinitely, since the agent really is still sitting there, until
a fresh report supersedes it or the source deletes its own file (a `SessionEnd`
hook, for example).

Adapters atomically publish one bounded JSON file per agent in
`~/.local/state/digital-terrarium/agents/`. The schema contains only version, ID,
display name, timestamp, phase, short detail, and an optional process or filesystem
target. Prompts, tool arguments, output, credentials, and session content do not
belong in this interface. The bridge validates and projects fresh reports at
`GET /api/agents`; malformed or stale reports are ignored.

Preview the visual behavior without an agent runtime:

```bash
npm run agent:demo
```

An integration can refresh its state while a run is active:

```bash
TERRARIUM_AGENT_ID=codex TERRARIUM_AGENT_NAME=Codex \
  node scripts/agent-activity.mjs publish tool apply_patch filesystem /home/quartermeat/work/digital-terrarium
node scripts/agent-activity.mjs stop
```

The publisher can also supervise any local agent or script. It refreshes the
heartbeat, forwards interruption signals, preserves the child's exit status,
briefly displays completion or failure, and always removes the state afterward:

```bash
TERRARIUM_AGENT_ID=worker TERRARIUM_AGENT_NAME='Local worker' \
  node scripts/agent-activity.mjs run 'system inquiry' process ollama -- \
  ollama run qwen3-coder:30b 'Summarize current system health'
```

Valid phases are `idle`, `thinking`, `working`, `tool`, `waiting`, and `error`.
Adapters reporting `thinking`, `working`, or `tool` must refresh at least every
five seconds or the report is dropped; `idle`, `waiting`, and `error` have no
such deadline. This small protocol is
intended for Codex wrappers, Ollama-backed workers, and future local agents; it
does not require a particular agent framework. `scripts/known-agents.json` is
a reference list of what's actually wired up (currently Claude and Codex) —
the runtime doesn't read it, since any conforming JSON file in the agents
directory renders regardless of its `id` prefix; it's just somewhere to note
a new adapter's hook script and config path when one gets added.

The user-level `~/.codex/hooks.json` sends supported Codex lifecycle events to
`scripts/codex-activity-hook.py`; `~/.claude/settings.json` does the same for
Claude Code via `scripts/claude-activity-hook.py`. Each hook invocation writes
exactly one sampled report — nothing keeps *that* report alive artificially,
and a report describing real activity (`thinking`/`working`/`tool`) still
ages out after five seconds with no further embellishment. But an agentic
CLI process being alive and available for commands is itself worth showing,
even in the gaps between hook events, so each hook also ensures a small
watchdog subprocess is running for the session: it periodically checks
whether the CLI process (found by walking up from the hook's own process
tree — the hook's immediate parent is a short-lived per-invocation wrapper,
not the long-lived CLI, so the walk goes a few levels further) is still
alive, and only ever fills in `waiting` once the last real report has
genuinely gone stale — never overwriting a fresh one, never guessing at
activity that isn't real. The watchdog stops and removes its own report the
moment the CLI process actually exits, or immediately on `SessionEnd`.
Reports never read transcripts, prompts, command arguments, or tool
results — only the documented lifecycle event, tool name, working directory
or file target, and a hashed session identifier.
`~/.local/bin/codex` launches the installed CLI normally. If explicitly invoked
through sudo by full path, it drops back to the desktop account rather than
granting the entire agent permanent root authority; commands needing elevation
still use the normal sudo policy.

`digital-terrarium.service` starts the desktop window at login and uses
`terrarium-mood.service` for the bridge. Both units live in `systemd/` and are
symlinked into `~/.config/systemd/user/`, so the always-on setup is version
controlled rather than existing only on one machine:

```bash
ln -sf "$PWD/systemd/digital-terrarium.service" ~/.config/systemd/user/
ln -sf "$PWD/systemd/terrarium-mood.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now digital-terrarium.service
```

Both restart always, not just on failure — a clean quit still leaves a desktop
with no terrarium on it — and both set `StartLimitIntervalSec=0` so a burst of
restarts can never defeat them permanently. Consequently `Ctrl+Alt+Q` restarts
the scene rather than ending it; to stop it for real, use
`systemctl --user stop digital-terrarium.service`. Restarting the bridge does
not replay startup playback, because the bridge records that in
`XDG_RUNTIME_DIR`, which the session clears on logout.

Ollama may remain available independently for on-demand local inference. The
graphical terrarium follows the desktop session.

## The grey

Lean toward the camera and a grey's head comes up over the habitat, drawn in
glowing wire. Sit back and it is gone. The camera does nothing else: it is a
spectacle, not a control surface.

Vision runs in its own hidden Electron renderer, never in the window that draws
the scene: MediaPipe inference must not compete with the habitat's frame budget,
and a vision failure cannot take the ecology down with it. That renderer owns the
camera, posts landmarks to `POST /api/vision`, and the bridge republishes them as
a `vision` event on `/api/stream` beside `ecosystem`, `agents`, and `audio`.

The head is **derived from** the tracked face, never traced from it. Tracing the
mesh faithfully produces a human face, which is the one thing it must not be:

- **The cranium is inverted.** MediaPipe's face oval measures skin over a human
  skull — widest at the cheeks, with a jaw as broad as the brow. A grey is the
  other way round: a vault that carries far above the eyes and is widest above
  them, tapering to a small chin. So the head is built from the oval's extent
  rather than its outline, and more of it sits above the widest line than below.
- **The chin is a rounded point**, not an apex. A single point gives a spade.
- **The eyes are the signature**, and they are sized against the derived cranium
  rather than the human face underneath — a grey's eyes are a fraction of its
  skull, not of your face. Each is a lopsided teardrop, pointed at the inner
  corner and deepest toward the outer third, slanting up and out. A symmetric
  lens reads as a cartoon eye. They are *positioned* on the real tracked eyes, so
  turning your head turns theirs.
- **The eye fill kills the glow first.** A lit shadow bleeds through the fill and
  turns a black eye grey, which is the one colour it must not be. One highlight
  high on the outer curve is what makes it read as wet rather than as a hole cut
  in the head.
- **No nose and no lips**: two derived nostril slits and a short bowed seam. The
  mesh measures a human face that has neither.
- **The electricity is the habitat's, not the creature's.** A grey has smooth
  skin, so the outline is stroked cleanly; bolts crawl between neighbouring
  points on it, anchored by index so they stay on the head as it moves. A chord
  straight across the face would read as a scratch on the screen.

Only the 68 landmarks the head is built from are transmitted — the face oval's
ring and both eye rings. Brows, lips and irises are measured by the model but
never drawn, so they never travel, and the full 478-point mesh would be a far
larger payload that is never rendered.

The head fades up with the measured face width from a quarter of the camera's
width to full at 32%. Measured live on this workstation, an ordinary seated
distance reads 22% and a deliberate lean reaches 33%, so shifting in the chair
will not summon a grey, but a comfortable lean brings it fully up.

Camera space is 16:9 and the habitat is as wide as the desktop, so x is scaled
about the centre to keep the head in proportion. The cost is that the outer
margin of a very wide screen sits outside camera reach, which is honest: the
camera genuinely cannot see there.

The camera stays open while the terrarium runs, and inference is idle-throttled:
roughly 24 detections a second while a near face is in frame, dropping to four a
second when none is, so an empty room costs almost nothing. The head expires half
a second after the last report, so a stopped feed leaves nothing pinned to the
scene.

The model is 3.6 MiB, fetched once on first request and served from
`~/.cache/digital-terrarium/` afterwards, so a restart without a network still
starts vision. `POST /api/vision` accepts loopback requests only, caps the body,
validates every landmark, and stamps arrival time itself so a skewed renderer
clock cannot decide freshness.

Topology is generated from the installed MediaPipe package rather than
hand-transcribed. After changing the `@mediapipe/tasks-vision` version, or the
set of parts the head is built from, run:

```bash
node scripts/generate-vision-topology.mjs
```

## Verification

```bash
npm test
npm run test:scene
npm run test:vision
```

The first command tests telemetry parsing, rate baselines, counter resets, PID
reuse, group identity, unavailable data, visual activity mappings, and Spotify
mood selection. The scene
check starts an isolated real Go bridge and a hidden Electron window, verifies
live telemetry, active/idle movement, hover behavior, stale-data handling,
and opaque wallpaper redraw. Agent phases and speaker audio are driven through
the real paths rather than stubbed in the page: agents through an isolated
`TERRARIUM_AGENT_STATE_DIR` the check writes files into, and audio through
`TERRARIUM_AUDIO_COMMAND` pointed at `scripts/test-speaker.mjs`, which emits the
same raw PCM shape as `parec` so capture and analysis run for real. It writes
local previews to `/tmp/digital-terrarium-scene.png` and
`/tmp/digital-terrarium-agent.png`, then closes its own processes.

The camera is driven the same way: the scene check posts synthetic landmarks to
the real `/api/vision` and asserts that the head stays hidden at a seated
distance, appears when leaned in, vanishes once the feed stops, and that the
derived geometry holds — the cranium carries above the measured face and
outweighs what is below it, the chin rises, the eyes slant up and out and mirror
each other, and only drawn parts travel over the feed. It saves
`/tmp/digital-terrarium-head.png`.

`npm run test:vision` is the one check that needs hardware and a person: it opens
the real camera, loads the model, and reports what it actually saw over twelve
seconds (`npm run test:vision 30` to watch for longer). It reports rather than
asserts a subject, exiting non-zero only when the camera never opened. It saves
the closest moment's landmarks to `/tmp/digital-terrarium-face.json`.

```bash
npm run head:replay -- 0.30
```

replays that captured face at any span and screenshots the scene at the primary
display's own aspect. Judging the head otherwise means a person holding still in
front of a camera at an exact distance while someone else reads the screen; a
replay at the wrong aspect judges proportions the scene never draws.
