package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMotesMintOnlyAgainstWholeReclaimedMebibytes(t *testing.T) {
	l := newLedger("")
	at := time.Unix(0, 0).UTC()
	if got := l.mint(3*(1<<20)+512, "partial", at); got != 3 {
		t.Fatalf("a mote is a whole reclaimed mebibyte, got %v", got)
	}
	if got := l.mint(1024, "crumbs", at); got != 0 {
		t.Fatalf("less than a mebibyte must mint nothing, got %v", got)
	}
	if state := l.snapshot(); state.Balance != 3 || state.Minted != 3 || len(state.Events) != 1 {
		t.Fatalf("bad ledger: %+v", state)
	}
}

func TestSpendingNeverOverdraws(t *testing.T) {
	l := newLedger("")
	at := time.Unix(0, 0).UTC()
	l.mint(10*(1<<20), "scrub", at)
	if got := l.spend(4, "bloom", at); got != 4 {
		t.Fatalf("expected 4, got %v", got)
	}
	if got := l.spend(100, "greedy bloom", at); got != 6 {
		t.Fatalf("a spend must be granted only what exists, got %v", got)
	}
	state := l.snapshot()
	if state.Balance != 0 || state.Spent != 10 {
		t.Fatalf("balance must floor at zero: %+v", state)
	}
	if got := l.spend(5, "on empty", at); got != 0 {
		t.Fatalf("an empty balance grants nothing, got %v", got)
	}
	for _, bad := range []float64{0, -5} {
		if got := l.spend(bad, "nonsense", at); got != 0 {
			t.Fatalf("spend(%v) must grant nothing, got %v", bad, got)
		}
	}
}

func TestLedgerSurvivesRestartAndCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "ledger.json")
	at := time.Unix(0, 0).UTC()
	first := newLedger(path)
	first.mint(7*(1<<20), "scrub", at)
	first.spend(2, "bloom", at)
	if state := newLedger(path).snapshot(); state.Balance != 5 || state.Minted != 7 || state.Spent != 2 {
		t.Fatalf("motes must outlive the process that earned them: %+v", state)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state := newLedger(path).snapshot(); state.Balance != 0 || state.Version != 1 {
		t.Fatalf("an unreadable ledger starts empty rather than refusing to run: %+v", state)
	}
}

func TestLedgerHistoryStaysBounded(t *testing.T) {
	l := newLedger("")
	at := time.Unix(0, 0).UTC()
	for i := 0; i < ledgerHistory+20; i++ {
		l.mint(1<<20, "scrub", at)
	}
	if state := l.snapshot(); len(state.Events) != ledgerHistory || state.Balance != float64(ledgerHistory+20) {
		t.Fatalf("history is capped but the balance is not: %d events, balance %v", len(state.Events), state.Balance)
	}
}
