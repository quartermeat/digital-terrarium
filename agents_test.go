package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAgentActivityValidation(t *testing.T) {
	now := time.Now()
	directory := t.TempDir()
	write := func(name, body string) { t.Helper(); if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0600); err != nil { t.Fatal(err) } }
	write("operator.json", `{"version":1,"id":"codex","name":"Codex","sampledAt":"`+now.Format(time.RFC3339Nano)+`","phase":"tool","detail":"apply_patch","target":{"kind":"filesystem","name":"/home/quartermeat/work"}}`)
	write("stale.json", `{"version":1,"id":"old","name":"Old","sampledAt":"`+now.Add(-time.Minute).Format(time.RFC3339Nano)+`","phase":"idle"}`)
	write("invalid.json", `{"version":1,"id":"bad","name":"Bad","sampledAt":"`+now.Format(time.RFC3339Nano)+`","phase":"executing arbitrary commands"}`)
	write("ignored.txt", "not json")
	got := readAgentActivities(directory, now)
	if len(got) != 1 || got[0].ID != "codex" || got[0].Target.Kind != "filesystem" { t.Fatalf("unexpected activities: %#v", got) }
}

func TestAgentFieldsRejectControlCharacters(t *testing.T) {
	a := AgentActivity{Version: 1, ID: "agent", Name: "bad\nname", SampledAt: time.Now(), Phase: "idle"}
	if validAgent(a, time.Now()) { t.Fatal("control characters must be rejected") }
}
