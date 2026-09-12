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
	if a.Version != 1 || !safeAgentID.MatchString(a.ID) ||
		a.Name == "" || !safeAgentField.MatchString(a.Name) || !safeAgentField.MatchString(a.Detail) ||
		now.Sub(a.SampledAt) < 0 || now.Sub(a.SampledAt) > 5*time.Second {
		return false
	}
	switch a.Phase {
	case "idle", "thinking", "working", "tool", "waiting", "error":
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

func agentActivityHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	home, _ := os.UserHomeDir()
	directory := os.Getenv("TERRARIUM_AGENT_STATE_DIR")
	if directory == "" {
		directory = filepath.Join(home, ".local", "state", "digital-terrarium", "agents")
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "sampledAt": time.Now(), "agents": readAgentActivities(directory, time.Now())})
}
