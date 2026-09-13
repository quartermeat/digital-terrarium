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

## The scrubber

`scrubber.go` decides what counts as abandoned, and the rule is deliberately
narrow: a process whose command line points into an agent scratchpad that no
living agent process holds a descriptor under. Two false positives it must keep
avoiding, both real cases on this machine:

- a live server holding *inherited* descriptors under a long-dead session, which
  is why only agent processes may establish a claim;
- a group that is only part dead, which is why rot is a share and not a verdict.

It signals supervisors only, with `SIGTERM`, at an evidence score of at least
0.85, and lets their own shutdown reap children. Scores combine scratchpad use,
reparenting, listening TCP sockets, and process age; supervisors can inherit a
child's score. Age is process lifetime, not time since the owning session ended.
Automatic termination is disarmed unless `TERRARIUM_SCRUB_AUTO=1` is set on the
bridge; manual POST cleanup is independent. Salvage remains available unarmed.
Motes use sampled RSS and are credited before confirmed exit; do not describe
the ledger as verified physical memory recovery. See README.md for limitations.
`./bin/digital-terrarium --orphans` prints the sweep without killing anything.

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

**Verifying it is working.** The bridge reports its build identity, so a
mismatch is a question rather than an investigation:

```bash
curl -s http://127.0.0.1:8091/api/health   # version must match package.json
```

A restart that lands on the new version needs no intervention. On 2026-09-12 the
first restart after the fix moved the bridge from 1.9.1 to 1.10.1 on its own,
where every earlier deploy that day had needed a PID killed by hand.

### History

Everything below describes the problem as it stood before v1.9.2. It is kept for
context, not as instructions: the line references are pre-fix and no longer point
at the code they name, and the remedies are superseded by the recovery path.

**Cause (pre-fix).** `ensureBridge()` skipped spawning a bridge when
`bridgeIsRunning()` said one was healthy, and that check only asked whether
`/api/health` reported `app: "digital-terrarium"` and `telemetryVersion: 1`.
Both are constants that do not change between releases, so *every* build of this
bridge looked identical to the check, and whatever already held
`127.0.0.1:8091` was adopted however old it was.

**Observed twice on 2026-09-12:**

- A bridge started 05:37 was still holding the port at 14:56. The v1.8.0
  Electron adopted it. That binary predated `/vision.html`, so the hidden vision
  renderer got a 404, died quietly, and the camera never opened. The reported
  fault was "the webcam LED is not on".
- A bridge started 14:56 survived the 15:08 restart even though the binary had
  been rebuilt at 15:07:42. The v1.9.0 scene ran against the v1.8.1 bridge and
  the feed still carried the removed `hands` field.

**A wrong turn worth remembering.** This report originally claimed the bridge was
escaping its cgroup, on the grounds that it outlived `systemctl --user restart`
under `KillMode=control-group`. That was wrong. The backend runs in its own
`terrarium-mood.service`, and restarting the display unit was never going to
restart a separate dependency. The surprising survival had an ordinary
explanation, and looking for an exotic one cost time.

**Manual recovery (pre-fix).** Superseded by the automatic recovery path; kept
only for an unmanaged backend on a custom address, which still fails visibly and
must be stopped by whoever started it.

```bash
systemctl --user stop digital-terrarium.service
pgrep -x digital-terrari | xargs -r kill
systemctl --user start digital-terrarium.service
```

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
