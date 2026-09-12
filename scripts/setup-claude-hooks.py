#!/usr/bin/env python3
"""One-off setup: wire Claude Code's lifecycle hooks into the Terrarium.

Merges hook entries into ~/.claude/settings.json so this Claude Code
session (and future ones) publish activity to
~/.local/state/digital-terrarium/agents/ via scripts/claude-activity-hook.py,
the same way ~/.codex/hooks.json already does for Codex.

Idempotent: safe to run more than once. Backs up the existing settings
file to settings.json.bak before writing.
"""

import json
import shutil
import sys
from pathlib import Path

SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
HOOK_SCRIPT = Path(__file__).resolve().parent / "claude-activity-hook.py"
COMMAND = f"/usr/bin/python3 {HOOK_SCRIPT}"

EVENTS = {
    "SessionStart": None,
    "SessionEnd": None,
    "UserPromptSubmit": None,
    "PreToolUse": ".*",
    "PermissionRequest": ".*",
    "PostToolUse": ".*",
    "SubagentStart": ".*",
    "SubagentStop": ".*",
    "Stop": None,
}


def load_settings():
    if not SETTINGS_PATH.exists():
        return {}
    text = SETTINGS_PATH.read_text().strip()
    if not text:
        return {}
    return json.loads(text)


def has_our_hook(group_list, matcher):
    for group in group_list:
        if group.get("matcher") == matcher:
            for hook in group.get("hooks", []):
                if hook.get("type") == "command" and hook.get("command") == COMMAND:
                    return True
    return False


def main():
    if not HOOK_SCRIPT.exists():
        sys.exit(f"error: {HOOK_SCRIPT} not found -- run this from the digital-terrarium checkout")

    settings = load_settings()
    hooks = settings.setdefault("hooks", {})
    added = []

    for event, matcher in EVENTS.items():
        group_list = hooks.setdefault(event, [])
        if has_our_hook(group_list, matcher):
            continue
        entry = {"hooks": [{"type": "command", "command": COMMAND, "timeout": 3}]}
        if matcher is not None:
            entry["matcher"] = matcher
        group_list.append(entry)
        added.append(event)

    if not added:
        print("Already up to date -- no changes needed.")
        return

    if SETTINGS_PATH.exists():
        backup = SETTINGS_PATH.with_suffix(".json.bak")
        shutil.copy2(SETTINGS_PATH, backup)
        print(f"Backed up existing settings to {backup}")

    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"Added hooks for: {', '.join(added)}")
    print(f"Updated {SETTINGS_PATH}")
    print("Run /hooks once (or restart Claude Code) to load the new config.")


if __name__ == "__main__":
    main()
