#!/usr/bin/env python3
"""Project Claude Code lifecycle events into the privacy-bounded Terrarium protocol."""

import calendar
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

# An elevated agent still belongs to the desktop that owns this checkout.
# Publish as that user so the bridge can read private (0600) activity files.
owner = pwd.getpwuid(Path(__file__).resolve().parent.parent.stat().st_uid)
if os.geteuid() == 0 and owner.pw_uid != 0:
    os.initgroups(owner.pw_name, owner.pw_gid)
    os.setgid(owner.pw_gid)
    os.setuid(owner.pw_uid)
desktop_home = Path(pwd.getpwuid(os.geteuid()).pw_dir)
AGENTS = desktop_home / ".local/state/digital-terrarium/agents"
SAFE = re.compile(r"[^a-zA-Z0-9_. /:@+-]")
HOST_COMM = "claude"
IDLE_AFTER = 2.5
WATCH_INTERVAL = 1
# Hooks fire when a tool starts and when it finishes, never while it runs, so a
# build or a test suite produces no events at all for minutes. Refreshing the
# reported phase in place keeps that work visible instead of letting it decay to
# "waiting" while it is still going. The cap is the safety net: a phase whose
# closing event never arrives resolves on its own rather than sticking forever.
MAX_HOLD = 600
IN_PROGRESS = ("thinking", "working", "tool")
AT_REST = ("idle", "waiting", "error")
WAITING = ("waiting", "ready for direction", {})


def clean(value, limit=96):
    return SAFE.sub("", str(value or ""))[:limit]


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def agent_path_for(session_id):
    identity = hashlib.sha256(("claude:" + session_id).encode()).hexdigest()[:12]
    return f"claude-{identity}", AGENTS / f"claude-{identity}.json"


def watch_pid_path(agent_path):
    return agent_path.with_suffix(".watch.pid")


def publish(agent_path, agent_id, phase, detail, target):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    activity = {
        "version": 1,
        "id": agent_id,
        "name": "Claude",
        "sampledAt": stamp,
        "phase": phase,
        "detail": detail,
    }
    if target.get("name"):
        activity["target"] = target
    atomic(agent_path, activity)
    return stamp


def tool_target(event):
    tool = clean(event.get("tool_name") or "tool", 64)
    inputs = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
    cwd = Path(event.get("cwd") or Path.home())
    candidate = inputs.get("file_path") or inputs.get("path") or inputs.get("workdir")
    if candidate:
        candidate = Path(str(candidate))
        path = candidate if candidate.is_absolute() else cwd / candidate
        return tool, {"kind": "filesystem", "name": clean(path, 96)}
    command = inputs.get("command")
    if tool == "Bash" and isinstance(command, str):
        executable = command.strip().split(maxsplit=1)[0].rsplit("/", 1)[-1]
        if re.fullmatch(r"[a-zA-Z0-9_.+-]{1,48}", executable):
            return tool, {"kind": "process", "name": executable}
    return tool, {"kind": "filesystem", "name": clean(cwd, 96)}


def host_pid():
    """Walk up the process tree to find the long-lived CLI process. The
    hook's immediate parent is a short-lived per-invocation wrapper that's
    typically already gone by the time the hook returns, so it's useless for
    a liveness check on its own — the actual host is a few levels up."""
    pid = os.getpid()
    for _ in range(12):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text()
        except OSError:
            return None
        comm = stat.split("(", 1)[1].rsplit(")", 1)[0]
        if comm == HOST_COMM:
            return pid
        fields = stat.rsplit(")", 1)[1].split()
        ppid = int(fields[1])
        if pid == ppid or ppid <= 1:
            return None
        pid = ppid
    return None


def stop_watch(agent_path):
    path = watch_pid_path(agent_path)
    try:
        pid = int(path.read_text())
    except (OSError, ValueError):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    path.unlink(missing_ok=True)


def watch_decision(current, now, mine, hold_until):
    """Decide what the watcher should write, given what is on disk.

    Returns (report, hold_until), where report is None to leave the file alone.
    Never invents activity: an in-progress phase is only ever repeated, and only
    while the report it came from is still within its hold.
    """
    try:
        stamp = current["sampledAt"]
        sampled = calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
        phase = current["phase"]
    except (TypeError, ValueError, KeyError):
        return WAITING, hold_until
    # At-rest phases describe a condition, not an event, and stay true until a
    # fresh report supersedes them.
    if phase in AT_REST:
        return None, hold_until
    if phase not in IN_PROGRESS:
        return WAITING, hold_until
    # A stamp this watcher did not write is a real hook report, so the work it
    # describes has just begun and earns a full hold.
    if stamp != mine:
        hold_until = now + MAX_HOLD
    if now - sampled <= IDLE_AFTER:
        return None, hold_until
    if now < hold_until:
        return (phase, current.get("detail", ""), current.get("target") or {}), hold_until
    return WAITING, hold_until


def watch_forever(agent_path, host, agent_id):
    def stop(*_):
        agent_path.unlink(missing_ok=True)
        watch_pid_path(agent_path).unlink(missing_ok=True)
        raise SystemExit

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    mine, hold_until = None, 0.0
    try:
        while True:
            try:
                os.kill(host, 0)
            except OSError:
                break
            try:
                current = json.loads(agent_path.read_text())
            except (OSError, ValueError):
                current = None
            # Takes over a short while after the last real report, staying
            # inside the bridge's five-second freshness window so presence
            # never blinks out between a report expiring and idle replacing it.
            report, hold_until = watch_decision(current, time.time(), mine, hold_until)
            if report is None:
                mine = None
            else:
                mine = publish(agent_path, agent_id, *report)
            time.sleep(WATCH_INTERVAL)
    finally:
        agent_path.unlink(missing_ok=True)
        watch_pid_path(agent_path).unlink(missing_ok=True)


def ensure_watch(agent_path, agent_id):
    path = watch_pid_path(agent_path)
    try:
        pid = int(path.read_text())
        os.kill(pid, 0)
        return
    except (OSError, ValueError):
        path.unlink(missing_ok=True)
    host = host_pid()
    if host is None:
        return
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--watch", str(agent_path), str(host), agent_id],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    path.write_text(str(process.pid))


def handle(event):
    session_id = str(event.get("session_id") or "unknown")
    agent_id, agent_path = agent_path_for(session_id)
    name = event.get("hook_event_name", "")
    if name == "SessionEnd":
        stop_watch(agent_path)
        agent_path.unlink(missing_ok=True)
        return
    if name in ("SubagentStart", "SubagentStop") and not event.get("agent_type"):
        # Claude Code runs internal subagents with no agent_type (background
        # summarization and the like); that isn't user-facing work, so leave
        # whatever phase is already on disk alone rather than clobbering a
        # persistent "waiting" report with transient noise.
        return
    phase, detail, target = "working", "active session", {}
    if name == "SessionStart":
        phase, detail = "idle", "session ready"
    elif name == "UserPromptSubmit":
        phase, detail = "thinking", "reasoning"
    elif name in ("PreToolUse", "PermissionRequest"):
        detail, target = tool_target(event)
        phase = "waiting" if name == "PermissionRequest" else "tool"
        if name == "PermissionRequest":
            detail = "approval requested for " + detail
    elif name == "PostToolUse":
        phase, detail = "thinking", "reviewing tool result"
    elif name == "SubagentStart":
        phase, detail = "working", "delegating to " + clean(event.get("agent_type") or "subagent", 48)
    elif name == "SubagentStop":
        phase, detail = "thinking", "reviewing subagent result"
    elif name == "Stop":
        phase, detail = "waiting", "ready for direction"
    publish(agent_path, agent_id, phase, detail, target)
    ensure_watch(agent_path, agent_id)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "--watch":
        watch_forever(Path(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    else:
        try:
            handle(json.load(sys.stdin))
        except Exception:
            # Observability must never block or alter the agent operation.
            pass
