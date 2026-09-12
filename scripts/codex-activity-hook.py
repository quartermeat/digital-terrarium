#!/usr/bin/env python3
"""Project Codex lifecycle events into the privacy-bounded Terrarium protocol."""

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
ROOT = desktop_home / ".local/state/digital-terrarium"
CONTROL = ROOT / "codex-controls"
AGENTS = ROOT / "agents"
SAFE = re.compile(r"[^a-zA-Z0-9_. /:@+-]")


def clean(value, limit=96):
    return SAFE.sub("", str(value or ""))[:limit]


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def paths(session_id):
    identity = hashlib.sha256(session_id.encode()).hexdigest()[:12]
    return identity, CONTROL / f"{identity}.json", AGENTS / f"codex-{identity}.json", CONTROL / f"{identity}.pid"


def publish(agent_path, control):
    activity = {
        "version": 1,
        "id": control["id"],
        "name": "Codex",
        "sampledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": control["phase"],
        "detail": control["detail"],
    }
    if control.get("target", {}).get("name"):
        activity["target"] = control["target"]
    atomic(agent_path, activity)


def heartbeat(control_path, agent_path, pid_path):
    def stop(*_):
        agent_path.unlink(missing_ok=True)
        pid_path.unlink(missing_ok=True)
        raise SystemExit

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while True:
            try:
                control = json.loads(control_path.read_text())
            except (OSError, ValueError):
                break
            age = time.time() - control.get("updated", 0)
            if age > (4 if control.get("terminal") else 1800):
                break
            publish(agent_path, control)
            time.sleep(1)
    finally:
        agent_path.unlink(missing_ok=True)
        control_path.unlink(missing_ok=True)
        pid_path.unlink(missing_ok=True)


def ensure_heartbeat(control_path, agent_path, pid_path):
    try:
        pid = int(pid_path.read_text())
        os.kill(pid, 0)
        return
    except (OSError, ValueError):
        pid_path.unlink(missing_ok=True)
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--heartbeat", str(control_path), str(agent_path), str(pid_path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    atomic(pid_path, process.pid)


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


def handle(event):
    session_id = str(event.get("session_id") or "unknown")
    identity, control_path, agent_path, pid_path = paths(session_id)
    name = event.get("hook_event_name", "")
    if name == "SessionEnd":
        control_path.unlink(missing_ok=True)
        agent_path.unlink(missing_ok=True)
        return
    phase, detail, target, terminal = "working", "active session", {}, False
    if name == "SessionStart":
        phase, detail, terminal = "idle", "session ready", True
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
        phase, detail, terminal = "waiting", "ready for direction", True
    elif name == "Interrupt":
        phase, detail, terminal = "waiting", "interrupted", True
    control = {"id": f"codex-{identity}", "phase": phase, "detail": detail, "target": target, "terminal": terminal, "updated": time.time()}
    atomic(control_path, control)
    publish(agent_path, control)
    ensure_heartbeat(control_path, agent_path, pid_path)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "--heartbeat":
        heartbeat(*(Path(value) for value in sys.argv[2:]))
    else:
        try:
            handle(json.load(sys.stdin))
        except Exception:
            # Observability must never block or alter the agent operation.
            pass
