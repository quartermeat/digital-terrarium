# Digital Terrarium agent guide

Inherits `/home/quartermeat/AGENTS.md`. This file records what is specific to
this project: how to verify it, and the problems known to be open.

## Verification

`npm test` covers telemetry, ecology, agent activity, and the derived head
geometry. `npm run test:scene` drives the real bridge and a real scene with real
feeds. `npm run test:vision` needs the camera and a person; it saves the closest
face it sees to `/tmp/digital-terrarium-face.json`, which
`npm run head:replay -- 0.30` then replays at the primary display's own aspect.
See README.md for detail.

## Known problems

### A stale bridge is silently reused, so a deploy can serve old code

**Status:** fixed for the managed desktop backend in v1.9.2. Health
reports the package version embedded at Go build time; Electron requires an
exact match and recycles `terrarium-mood.service` on mismatch, waiting for the
matching version before loading renderers. Custom-address or unmanaged stale
backends fail visibly and require their owner to stop/rebuild them.

The backend is deliberately in the separate `terrarium-mood.service` cgroup.
Restarting only the display does not restart that dependency; this is not
evidence of a child escaping its cgroup. Recovery signals the backend unit's
main process, allowing `Restart=always` to restore it. Systemd also recycles the
dependent display, whose next startup rechecks the version. The historical
investigation below is retained for context.

**Symptom.** After restarting `digital-terrarium.service`, the scene runs
normally but serves the *previous* build. Nothing errors and nothing logs, so the
deploy looks successful. Only the behaviour is wrong.

**Cause.** `ensureBridge()` (`electron-main.js:33`) skips spawning a bridge when
`bridgeIsRunning()` (`electron-main.js:18`) says one is healthy, and that check
(`electron-main.js:24`) only asks whether `/api/health` reports
`app: "digital-terrarium"` and `telemetryVersion: 1`. Both fields are constants
in `server.go:105` and do not change between releases, so *every* build of this
bridge looks identical to the check. Whatever is already holding
`127.0.0.1:8091` is adopted, however old it is.

**Observed twice on 2026-09-12:**

- A bridge started 05:37 was still holding the port at 14:56, outside the
  service cgroup. The v1.8.0 Electron adopted it. That binary predated
  `/vision.html`, so the hidden vision renderer got a 404, died quietly, and the
  camera never opened. The reported fault was "the webcam LED is not on".
- A bridge started 14:56 survived the 15:08 restart even though the binary had
  been rebuilt at 15:07:42. The v1.9.0 scene ran against the v1.8.1 bridge and
  the feed still carried the removed `hands` field.

**Second, related problem.** In both cases the bridge outlived
`systemctl --user restart`, which a `KillMode=control-group` unit should not
allow. Something is escaping the service cgroup — probably the bridge being
spawned as an Electron child and reparented. The version check below makes the
symptom visible and self-correcting, but it does not explain this, and it is
worth investigating separately.

**How to detect it.** The bridge should never be older than the service:

```bash
systemctl --user show -p ActiveEnterTimestamp digital-terrarium.service
pgrep -x digital-terrari | xargs -r ps -o pid,etime,args -p
```

**How to clear it.** Stop the unit, kill the bridge *by PID*, then start:

```bash
systemctl --user stop digital-terrarium.service
pgrep -x digital-terrari | xargs -r kill
systemctl --user start digital-terrarium.service
```

**Proposed fix.** Report the package version from `/api/health`, have
`bridgeIsRunning()` return false when it does not match Electron's own version,
and have `ensureBridge()` shut a mismatched bridge down before spawning rather
than racing it for the port. Add a test that a mismatched bridge is rejected.

## Gotchas

- **Never `pkill -f "bin/digital-terrarium"`.** The pattern matches the invoking
  shell's own command line, so the shell kills itself and the command dies with
  exit 144 before reaching the bridge. Use `pkill -x digital-terrari` (the
  comm name is truncated to 15 characters) or kill by PID.
- The camera is an exclusive device. `npm run test:vision` and
  `npm run head:replay` cannot open it while the service holds it; stop the
  service first.
- A bare `go build` in this directory writes `./digital-terrarium`, which is not
  the build output the project uses. `npm run build:bridge` writes `bin/`.
