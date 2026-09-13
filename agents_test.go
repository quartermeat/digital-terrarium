package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentWatcherLiveness(t *testing.T) {
	directory := t.TempDir()
	agentPath := filepath.Join(directory, "codex-test.json")
	procDirectory := filepath.Join(directory, "proc")
	if !agentWatcherAlive(agentPath, "codex-test", procDirectory) {
		t.Fatal("standalone publishers need no watcher")
	}
	write := func(path, content string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	sidecar := filepath.Join(directory, "codex-test.watch.pid")
	write(sidecar, "123")
	if agentWatcherAlive(agentPath, "codex-test", procDirectory) {
		t.Fatal("dead watcher accepted")
	}
	if err := os.MkdirAll(filepath.Join(procDirectory, "123"), 0700); err != nil {
		t.Fatal(err)
	}
	commandPath := filepath.Join(procDirectory, "123", "cmdline")
	for _, script := range []string{"claude-activity-hook.py", "codex-activity-hook.py"} {
		write(commandPath, strings.Join([]string{"python3", "/scripts/" + script, "--watch", agentPath, "456", "codex-test", ""}, "\x00"))
		if !agentWatcherAlive(agentPath, "codex-test", procDirectory) {
			t.Fatal("live watcher rejected")
		}
		if agentWatcherAlive(agentPath, "another-session", procDirectory) {
			t.Fatal("wrong session accepted")
		}
	}
	write(commandPath, "unrelated\x00")
	if agentWatcherAlive(agentPath, "codex-test", procDirectory) {
		t.Fatal("reused PID accepted")
	}
	write(commandPath, "")
	if agentWatcherAlive(agentPath, "codex-test", procDirectory) {
		t.Fatal("zombie accepted")
	}
	write(sidecar, "invalid")
	if agentWatcherAlive(agentPath, "codex-test", procDirectory) {
		t.Fatal("invalid PID accepted")
	}
}

func TestAgentActivityValidation(t *testing.T) {
	now := time.Now()
	directory := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("operator.json", `{"version":1,"id":"codex","name":"Codex","sampledAt":"`+now.Format(time.RFC3339Nano)+`","phase":"tool","detail":"apply_patch","target":{"kind":"filesystem","name":"/home/quartermeat/work"}}`)
	write("stale-tool.json", `{"version":1,"id":"old-tool","name":"Old","sampledAt":"`+now.Add(-time.Minute).Format(time.RFC3339Nano)+`","phase":"tool"}`)
	write("stale-waiting.json", `{"version":1,"id":"old-waiting","name":"Old","sampledAt":"`+now.Add(-time.Hour).Format(time.RFC3339Nano)+`","phase":"waiting"}`)
	write("invalid.json", `{"version":1,"id":"bad","name":"Bad","sampledAt":"`+now.Format(time.RFC3339Nano)+`","phase":"executing arbitrary commands"}`)
	write("ignored.txt", "not json")
	got := readAgentActivities(directory, now)
	if len(got) != 2 || got[0].ID != "codex" || got[0].Target.Kind != "filesystem" || got[1].ID != "old-waiting" {
		t.Fatalf("unexpected activities: %#v", got)
	}
}

func TestAgentFieldsRejectControlCharacters(t *testing.T) {
	a := AgentActivity{Version: 1, ID: "agent", Name: "bad\nname", SampledAt: time.Now(), Phase: "idle"}
	if validAgent(a, time.Now()) {
		t.Fatal("control characters must be rejected")
	}
}
