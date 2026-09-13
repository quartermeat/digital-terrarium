package main

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Motes are the one invented quantity in this system, and they are kept honest
// by what is allowed to create them: a mote exists only because a measured byte
// of memory was actually reclaimed from a dead session's leftovers. Nothing
// mints on a timer, on activity, or on an estimate. One mote per mebibyte.
//
// They are spent as well as earned, because a balance that only grows is a
// score rather than a currency. The habitat burns motes to bloom, so a machine
// that is never scrubbed slowly goes dark and a freshly scrubbed one lights up.
const bytesPerMote = 1 << 20
const ledgerHistory = 32

type ledgerEvent struct {
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"`
	Amount float64   `json:"amount"`
	Reason string    `json:"reason"`
}

type ledgerState struct {
	Version int           `json:"version"`
	Balance float64       `json:"balance"`
	Minted  float64       `json:"minted"`
	Spent   float64       `json:"spent"`
	Events  []ledgerEvent `json:"events"`
}

type ledger struct {
	sync.Mutex
	path  string
	state ledgerState
}

func newLedger(path string) *ledger {
	l := &ledger{path: path, state: ledgerState{Version: 1, Events: []ledgerEvent{}}}
	if data, err := os.ReadFile(path); err == nil {
		var stored ledgerState
		// A ledger that cannot be read starts empty rather than refusing to
		// run: motes are a garnish on the scene, never a reason it fails.
		if json.Unmarshal(data, &stored) == nil && stored.Version == 1 {
			if stored.Events == nil {
				stored.Events = []ledgerEvent{}
			}
			l.state = stored
		}
	}
	return l
}

func (l *ledger) persist() {
	if l.path == "" {
		return
	}
	data, err := json.Marshal(l.state)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return
	}
	// Written beside the target and renamed, so a crash mid-write cannot
	// truncate a balance that took real cleanups to earn.
	temporary := l.path + ".tmp"
	if os.WriteFile(temporary, data, 0o600) == nil {
		os.Rename(temporary, l.path)
	}
}

func (l *ledger) record(kind string, amount float64, reason string, at time.Time) {
	l.state.Events = append(l.state.Events, ledgerEvent{At: at, Kind: kind, Amount: amount, Reason: reason})
	if len(l.state.Events) > ledgerHistory {
		l.state.Events = l.state.Events[len(l.state.Events)-ledgerHistory:]
	}
}

func (l *ledger) mint(bytes uint64, reason string, at time.Time) float64 {
	amount := math.Floor(float64(bytes) / bytesPerMote)
	if amount <= 0 {
		return 0
	}
	l.Lock()
	defer l.Unlock()
	l.state.Balance += amount
	l.state.Minted += amount
	l.record("mint", amount, reason, at)
	l.persist()
	return amount
}

// Spending never overdraws: the habitat asks for what it wants to burn and is
// told what it actually got, so an empty balance dims the bloom instead of
// driving the balance negative.
func (l *ledger) spend(amount float64, reason string, at time.Time) float64 {
	if amount <= 0 || math.IsNaN(amount) {
		return 0
	}
	l.Lock()
	defer l.Unlock()
	granted := math.Min(amount, l.state.Balance)
	if granted <= 0 {
		return 0
	}
	l.state.Balance -= granted
	l.state.Spent += granted
	l.record("spend", granted, reason, at)
	l.persist()
	return granted
}

func (l *ledger) snapshot() ledgerState {
	l.Lock()
	defer l.Unlock()
	out := l.state
	out.Events = append([]ledgerEvent{}, l.state.Events...)
	return out
}

func (l *ledger) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var request struct {
			Amount float64 `json:"amount"`
			Reason string  `json:"reason"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid spend"})
			return
		}
		reason := request.Reason
		if reason == "" {
			reason = "habitat bloom"
		}
		granted := l.spend(request.Amount, reason, time.Now())
		writeJSON(w, http.StatusOK, map[string]any{"granted": granted, "balance": l.snapshot().Balance})
		return
	}
	writeJSON(w, http.StatusOK, l.snapshot())
}
