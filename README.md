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
| Electronic process creature | Current user's processes grouped by Linux command name | Speed and brightness follow CPU activity. Size follows summed RSS. Idle groups stop moving. Groups appear/disappear with the sampled process list. |
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
No commands, environment variables, browser content, network destinations, or
packet contents are collected. Only the current user's process groups are shown;
memory, network, and disk measurements cover the machine.

Missing measurements are null, not zero. The first counter sample establishes a
baseline. Counter resets and PID reuse do not produce activity spikes. When the
feed fails or becomes more than five seconds old, motion/emissions stop and
entities turn gray; hover details identify readings as stale.

The display is bounded to 128 process groups, eight filesystems, six interfaces,
and 160 transient particles. Stable slots preserve process identity when the list
changes. CPU-driven movement runs on WebGPU when available, then WebGL2 transform
feedback, with a JavaScript fallback. Hover content and drawing remain on the
CPU; rendering uses Canvas 2D acceleration. Compact state is read back each tick,
so GPU compute is not a claim of better performance at this population size.

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
does not require a particular agent framework.

The user-level `~/.codex/hooks.json` sends supported Codex lifecycle events to
`scripts/codex-activity-hook.py`; `~/.claude/settings.json` does the same for
Claude Code via `scripts/claude-activity-hook.py`. Each hook invocation writes
exactly one sampled report and exits — there is no background heartbeat
process republishing a stale phase between events. A quiet agent simply ages
past the five-second freshness window and disappears; nothing keeps it alive
artificially. Reports never read transcripts, prompts, command arguments, or
tool results — only the documented lifecycle event, tool name, working
directory or file target, and a hashed session identifier.
`~/.local/bin/codex` launches the installed CLI normally. If explicitly invoked
through sudo by full path, it drops back to the desktop account rather than
granting the entire agent permanent root authority; commands needing elevation
still use the normal sudo policy.

`digital-terrarium.service` starts the desktop window at login and uses
`terrarium-mood.service` for the bridge. Ollama may remain available independently
for on-demand local inference. The graphical terrarium follows the desktop session.

## Verification

```bash
npm test
npm run test:scene
```

The first command tests telemetry parsing, rate baselines, counter resets, PID
reuse, group identity, unavailable data, visual activity mappings, and Spotify
mood selection. The scene
check starts an isolated real Go bridge and a hidden Electron window, verifies
live telemetry, GPU active/idle movement, hover behavior, stale-data handling,
and opaque wallpaper redraw. It writes a local preview to
`/tmp/digital-terrarium-scene.png`, then closes its own processes.
