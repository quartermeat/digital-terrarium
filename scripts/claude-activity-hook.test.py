#!/usr/bin/env python3
"""Tests for the watcher's decision about what to report between hook events."""

import importlib.util
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "activity_hook", Path(__file__).resolve().parent / "claude-activity-hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)

NOW = 1_800_000_000


def report(phase, ageSeconds=0, detail="Bash", target=None):
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - ageSeconds))
    body = {"version": 1, "id": "a", "name": "Claude", "sampledAt": stamp, "phase": phase, "detail": detail}
    if target:
        body["target"] = target
    return body, stamp


class WatchDecision(unittest.TestCase):
    def decide(self, current, now=NOW, mine=None, hold_until=0.0):
        return hook.watch_decision(current, now, mine, hold_until)

    def test_a_running_tool_keeps_reporting_itself(self):
        """Hooks fire at the start and end of a tool, never during it, so a long
        one must be repeated rather than allowed to decay into waiting."""
        current, stamp = report("tool", ageSeconds=30, target={"kind": "filesystem", "name": "/tmp"})
        # First pass: a stamp the watcher did not write starts the hold.
        action, hold = self.decide(current)
        self.assertEqual(action, ("tool", "Bash", {"kind": "filesystem", "name": "/tmp"}))
        self.assertEqual(hold, NOW + hook.MAX_HOLD)
        # Later passes keep repeating it while the hold lasts.
        action, hold = self.decide(current, now=NOW + 120, mine=stamp, hold_until=hold)
        self.assertEqual(action[0], "tool")

    def test_a_fresh_report_is_left_alone(self):
        current, _ = report("tool", ageSeconds=0)
        self.assertIsNone(self.decide(current)[0])

    def test_at_rest_phases_are_never_touched(self):
        """They describe a condition, not an event, and stay true until a fresh
        report supersedes them, however old they are."""
        for phase in hook.AT_REST:
            current, _ = report(phase, ageSeconds=9999)
            self.assertIsNone(self.decide(current)[0], phase)

    def test_a_phase_that_never_closes_gives_up_eventually(self):
        """The safety net: a missing closing event must resolve on its own
        rather than leaving the agent reporting work forever."""
        current, stamp = report("thinking", ageSeconds=hook.MAX_HOLD + 60)
        action, _ = self.decide(current, mine=stamp, hold_until=NOW - 1)
        self.assertEqual(action, hook.WAITING)

    def test_a_new_report_restarts_the_hold(self):
        """Two consecutive tools of the same name must not inherit the first
        one's remaining hold."""
        current, _ = report("tool", ageSeconds=30)
        action, hold = self.decide(current, mine="an-older-stamp-we-wrote", hold_until=NOW - 1)
        self.assertEqual(action[0], "tool", "a real hook report is honoured, not retired")
        self.assertEqual(hold, NOW + hook.MAX_HOLD)

    def test_unreadable_or_unknown_state_falls_back_to_waiting(self):
        for current in (None, {}, {"phase": "tool"}, {"sampledAt": "not a time", "phase": "tool"},
                        {"sampledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW)),
                         "phase": "executing arbitrary commands"}):
            self.assertEqual(self.decide(current)[0], hook.WAITING, current)

    def test_activity_is_repeated_but_never_invented(self):
        """The watcher may only ever echo a phase the hooks actually reported."""
        current, _ = report("working", ageSeconds=30, detail="active session")
        action, _ = self.decide(current)
        self.assertEqual(action[:2], ("working", "active session"))


if __name__ == "__main__":
    unittest.main()
