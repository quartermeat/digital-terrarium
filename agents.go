package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

type AgentTarget struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type AgentActivity struct {
	Version   int         `json:"version"`
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	SampledAt time.Time   `json:"sampledAt"`
	Phase     string      `json:"phase"`
	Detail    string      `json:"detail,omitempty"`
	Target    AgentTarget `json:"target,omitempty"`
}

var safeAgentField = regexp.MustCompile(`^[a-zA-Z0-9_. /:@+-]{0,96}$`)
var safeAgentID = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,48}$`)

func validAgent(a AgentActivity, now time.Time) bool {
	age := now.Sub(a.SampledAt)
	if a.Version != 1 || !safeAgentID.MatchString(a.ID) ||
		a.Name == "" || !safeAgentField.MatchString(a.Name) || !safeAgentField.MatchString(a.Detail) ||
		age < 0 {
		return false
	}
	switch a.Phase {
	// At-rest phases represent a condition, not an event in progress: they
	// stay valid until a fresh sample supersedes them or the source deletes
	// its own file (e.g. on SessionEnd), rather than expiring on a timer.
	case "idle", "waiting", "error":
	case "thinking", "working", "tool":
		if age > 5*time.Second {
			return false
		}
	default:
		return false
	}
	switch a.Target.Kind {
	case "", "process", "filesystem":
	default:
		return false
	}
	return safeAgentField.MatchString(a.Target.Name)
}

func readAgentActivities(directory string, now time.Time) []AgentActivity {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return []AgentActivity{}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	out := []AgentActivity{}
	for _, entry := range entries {
		if len(out) == 16 || entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		file, err := os.Open(filepath.Join(directory, entry.Name()))
		if err != nil {
			continue
		}
		var activity AgentActivity
		err = json.NewDecoder(io.LimitReader(file, 8192)).Decode(&activity)
		file.Close()
		if err == nil && validAgent(activity, now) {
			out = append(out, activity)
		}
	}
	return out
}

func agentActivityPayload() map[string]any {
	home, _ := os.UserHomeDir()
	directory := os.Getenv("TERRARIUM_AGENT_STATE_DIR")
	if directory == "" {
		directory = filepath.Join(home, ".local", "state", "digital-terrarium", "agents")
	}
	now := time.Now()
	return map[string]any{"version": 1, "sampledAt": now, "agents": readAgentActivities(directory, now)}
}

func agentActivityHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, agentActivityPayload())
}
