#!/usr/bin/env python3
"""Project Claude Code lifecycle events into the privacy-bounded Terrarium protocol."""

import hashlib
import json
import os
import pwd
from pathlib import Path
import re
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


def publish(agent_path, agent_id, phase, detail, target):
    activity = {
        "version": 1,
        "id": agent_id,
        "name": "Claude",
        "sampledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": phase,
        "detail": detail,
    }
    if target.get("name"):
        activity["target"] = target
    atomic(agent_path, activity)


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
    agent_id, agent_path = agent_path_for(session_id)
    name = event.get("hook_event_name", "")
    if name == "SessionEnd":
        agent_path.unlink(missing_ok=True)
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
    # No heartbeat: publish exactly what was sampled and let it age out (the
    # bridge drops anything older than five seconds) rather than keeping a
    # background process alive to keep republishing a stale phase.
    publish(agent_path, agent_id, phase, detail, target)


if __name__ == "__main__":
    try:
        handle(json.load(sys.stdin))
    except Exception:
        # Observability must never block or alter the agent operation.
        pass
