package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const deadSession = "342d7241-d1a7-4667-bd4e-fb6876ef5691"
const liveSession = "b03c9a4d-35d0-441b-b005-85b45003c579"

func scratch(session, tail string) string {
	return "/tmp/claude-1000/-home-quartermeat/" + session + "/scratchpad/" + tail
}

func procStat(name string, ppid, rssPages, startTicks int) string {
	f := strings.Fields("S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 5")
	f[1] = fmt.Sprint(ppid)
	f[19] = fmt.Sprint(startTicks)
	f[21] = fmt.Sprint(rssPages)
	return "1 (" + name + ") " + strings.Join(f, " ")
}

// Fixtures boot long ago, so a process starting at tick zero reads as old
// enough to scrub unless a test says otherwise.
const fixtureUptime = 100000

type fakeProcess struct {
	pid    string
	name   string
	ppid   int
	pages  int
	uid    int
	args   []string
	fds    []string
	cwd    string
	noStat bool
	start  int
}

func fakeProc(t *testing.T, processes ...fakeProcess) string {
	t.Helper()
	root := fakeProcNoUptime(t, processes...)
	if err := os.WriteFile(filepath.Join(root, "uptime"), []byte(fmt.Sprintf("%d.00 0.00\n", fixtureUptime)), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func fakeProcNoUptime(t *testing.T, processes ...fakeProcess) string {
	t.Helper()
	root := t.TempDir()
	for _, p := range processes {
		dir := filepath.Join(root, p.pid)
		if err := os.MkdirAll(filepath.Join(dir, "fd"), 0o700); err != nil {
			t.Fatal(err)
		}
		uid := p.uid
		if uid == 0 {
			uid = 1000
		}
		write := func(name, body string) {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		write("status", fmt.Sprintf("Uid:\t%d\t%d\t%d\t%d\nThreads:\t3\n", uid, uid, uid, uid))
		if !p.noStat {
			write("stat", procStat(p.name, p.ppid, p.pages, p.start))
		}
		write("cmdline", strings.Join(p.args, "\x00")+"\x00")
		for i, target := range p.fds {
			if err := os.Symlink(target, filepath.Join(dir, "fd", fmt.Sprint(i))); err != nil {
				t.Fatal(err)
			}
		}
		if p.cwd != "" {
			if err := os.Symlink(p.cwd, filepath.Join(dir, "cwd")); err != nil {
				t.Fatal(err)
			}
		}
	}
	return root
}

// /proc/net/tcp as the kernel lays it out: state 0A is LISTEN, inode is the
// tenth field, and it is what a process's socket: descriptors point at.
func listenOn(t *testing.T, root string, inodes ...string) {
	t.Helper()
	body := "  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n"
	for i, inode := range inodes {
		body += fmt.Sprintf("  %2d: 00000000:6996 00000000:0000 0A 00:00000000 00:00000000 00 1000 0 %s 1 0 0\n", i, inode)
	}
	if err := os.MkdirAll(filepath.Join(root, "net"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "net", "tcp"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAgentGripDecidesOwnership(t *testing.T) {
	root := fakeProc(t,
		// A live session, proven live by the agent's own open descriptor.
		fakeProcess{pid: "100", name: "claude", args: []string{"claude"}, fds: []string{scratch(liveSession, "tasks")}},
		// Work belonging to that live session must survive the sweep.
		fakeProcess{pid: "101", name: "crewmate", ppid: 100, pages: 10,
			args: []string{"./crewmate", "serve", "-save", scratch(liveSession, "world.zip")}},
		// The dead session: no agent holds it any more.
		fakeProcess{pid: "200", name: "crewmate", ppid: 1, pages: 100,
			args: []string{"./crewmate", "serve", "-save", scratch(deadSession, "world.zip")}},
		fakeProcess{pid: "201", name: "factorio", ppid: 200, pages: 1000,
			args: []string{"/games/factorio", "--start-server", scratch(deadSession, "world.zip")}},
	)
	orphans := scanOrphans(root, 1000)
	if len(orphans) != 2 {
		t.Fatalf("expected the dead session's two processes, got %+v", orphans)
	}
	if orphans[0].PID != 200 || orphans[0].Session != deadSession {
		t.Fatalf("wrong orphan: %+v", orphans[0])
	}
	if !orphans[0].Supervisor {
		t.Fatal("the root of the orphan tree must be the one signalled")
	}
	if orphans[1].PID != 201 || orphans[1].Supervisor {
		t.Fatalf("a child must be reaped by its supervisor, not signalled: %+v", orphans[1])
	}
}

// The bug this rule exists to avoid: a server started from one session and
// outliving it keeps descriptors open under that dead scratchpad, and so does
// an unrelated sibling. Neither is an agent, so neither may forge a claim.
func TestInheritedDescriptorsAreNotAClaim(t *testing.T) {
	root := fakeProc(t,
		fakeProcess{pid: "200", name: "crewmate", ppid: 1, pages: 100,
			args: []string{"./crewmate", "serve", "-save", scratch(deadSession, "world.zip")},
			fds:  []string{scratch(deadSession, "pers/factorio-current.log")}},
		// A live companion holding inherited descriptors under the dead
		// session, but whose own command points at a real save.
		fakeProcess{pid: "300", name: "crewmate", ppid: 1, pages: 50,
			args: []string{"./crewmate", "serve", "-save", "/home/quartermeat/.factorio/saves/companion.zip"},
			fds:  []string{scratch(deadSession, "pers/factorio-current.log")}},
	)
	orphans := scanOrphans(root, 1000)
	if len(orphans) != 1 || orphans[0].PID != 200 {
		t.Fatalf("a non-agent grip must neither save an orphan nor condemn a bystander: %+v", orphans)
	}
}

func TestScanIgnoresOtherUsersAndUnreadableProcesses(t *testing.T) {
	root := fakeProc(t,
		fakeProcess{pid: "400", name: "crewmate", ppid: 1, pages: 10, uid: 4242,
			args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")}},
		fakeProcess{pid: "401", name: "crewmate", ppid: 1, noStat: true,
			args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")}},
		fakeProcess{pid: "402", name: "bash", ppid: 1, pages: 1, args: []string{"bash", "-c", "echo hello"}},
	)
	if orphans := scanOrphans(root, 1000); len(orphans) != 0 {
		t.Fatalf("only this user's readable processes may be scrubbed: %+v", orphans)
	}
}

func TestScrubSignalsSupervisorsOnlyAndMintsAgainstTheWholeTree(t *testing.T) {
	pageSize := uint64(os.Getpagesize())
	// Sized so supervisor and child together clear a whole number of mebibytes.
	childPages := int(8 * (1 << 20) / pageSize)
	root := fakeProc(t,
		fakeProcess{pid: "200", name: "crewmate", ppid: 1, pages: 0,
			args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")},
			fds:  []string{scratch(deadSession, "world.zip")}},
		fakeProcess{pid: "201", name: "factorio", ppid: 200, pages: childPages,
			args: []string{"/games/factorio", "--start-server", scratch(deadSession, "world.zip")},
			fds:  []string{scratch(deadSession, "world.zip"), "socket:[4242]"}},
	)
	listenOn(t, root, "4242")
	signalled := []int{}
	s := newScrubber(root, 1000, newLedger(filepath.Join(t.TempDir(), "ledger.json")))
	s.now = func() time.Time { return time.Unix(0, 0).UTC() }
	s.signal = func(pid int, sig syscall.Signal) error {
		if sig != syscall.SIGTERM {
			t.Fatalf("the scrubber asks with SIGTERM, it does not force: %v", sig)
		}
		signalled = append(signalled, pid)
		return nil
	}
	result := s.scrub()
	if len(signalled) != 1 || signalled[0] != 200 {
		t.Fatalf("only the supervisor may be signalled, got %v", signalled)
	}
	if result.Minted != 8 {
		t.Fatalf("a mote per reclaimed mebibyte across the tree, got %v", result.Minted)
	}
	if result.Balance != 8 {
		t.Fatalf("minting must reach the balance, got %v", result.Balance)
	}
}

func TestScrubMintsNothingWhenNothingWasSignalled(t *testing.T) {
	s := newScrubber(t.TempDir(), 1000, newLedger(filepath.Join(t.TempDir(), "ledger.json")))
	s.signal = func(pid int, sig syscall.Signal) error { return fmt.Errorf("no such process") }
	if result := s.scrub(); result.Minted != 0 || len(result.Signalled) != 0 {
		t.Fatalf("an empty sweep must not mint: %+v", result)
	}
}

func TestPayloadCountsOrphansPerGroup(t *testing.T) {
	root := fakeProc(t,
		fakeProcess{pid: "200", name: "factorio", ppid: 1, pages: 10,
			args: []string{"/games/factorio", scratch(deadSession, "a.zip")}},
		fakeProcess{pid: "300", name: "factorio", ppid: 1, pages: 10,
			args: []string{"/games/factorio", scratch(deadSession, "b.zip")}},
	)
	s := newScrubber(root, 1000, newLedger(""))
	payload := s.payload()
	if payload.Groups["factorio"].Dead != 2 {
		t.Fatalf("a part-dead group must report how much of it is dead: %+v", payload.Groups)
	}
	recorder := httptest.NewRecorder()
	s.serveOrphans(recorder, httptest.NewRequest("GET", "/api/orphans", nil))
	var decoded orphanPayload
	if json.NewDecoder(recorder.Body).Decode(&decoded) != nil || decoded.Version != 1 || len(decoded.Orphans) != 2 {
		t.Fatalf("bad payload: %s", recorder.Body.String())
	}
}

func TestScrubRefusesGET(t *testing.T) {
	s := newScrubber(t.TempDir(), 1000, newLedger(""))
	recorder := httptest.NewRecorder()
	s.serveScrub(recorder, httptest.NewRequest("GET", "/api/scrub", nil))
	if recorder.Code != 405 {
		t.Fatalf("killing must not be reachable by navigation, got %d", recorder.Code)
	}
}

// The defect this replaced a blunt timer to close: a shell command that merely
// quotes a dead scratchpad -- tailing its log, grepping its mods -- may be
// reported so the tank can show it, but must never gather enough evidence to
// be signalled, however long it runs.
func TestACommandThatOnlyQuotesADeadSessionIsNeverSureEnoughToScrub(t *testing.T) {
	for _, age := range []int{5, 600, 100000} {
		root := fakeProc(t, fakeProcess{pid: "500", name: "tail", ppid: 1, pages: 1,
			start: (fixtureUptime - age) * clockTicks,
			args:  []string{"tail", "-4", scratch(deadSession, "pers/factorio-current.log")},
			fds:   []string{scratch(deadSession, "pers/factorio-current.log")}})
		orphans := scanOrphans(root, 1000)
		if len(orphans) != 1 {
			t.Fatalf("age %d: expected it reported, got %+v", age, orphans)
		}
		if orphans[0].Confidence >= scrubThreshold {
			t.Fatalf("age %ds: a log reader reached %v, at or above the threshold %v",
				age, orphans[0].Confidence, scrubThreshold)
		}
	}
}

func TestAnUnreadableAgeEarnsNothingRatherThanGuessing(t *testing.T) {
	root := fakeProcNoUptime(t, fakeProcess{pid: "600", name: "crewmate", ppid: 1, pages: 10,
		args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")}})
	orphans := scanOrphans(root, 1000)
	if len(orphans) != 1 || orphans[0].AgeSeconds != 0 || orphans[0].Confidence >= scrubThreshold {
		t.Fatalf("an unreadable clock must earn no confidence: %+v", orphans)
	}
	if _, ok := processAge(100, "bad", true); ok {
		t.Fatal("an unparseable start time must not yield an age")
	}
	if _, ok := processAge(100, "999999999", true); ok {
		t.Fatal("a start in the future must not yield an age")
	}
}

func TestConfidenceIsAssembledFromNamedEvidence(t *testing.T) {
	none, evidence := deadConfidence(false, false, false, 0)
	if none != 0 || len(evidence) != 0 {
		t.Fatalf("no observation, no confidence: %v %v", none, evidence)
	}
	all, evidence := deadConfidence(true, true, true, outlivedFull)
	if all != 1 || len(evidence) != 4 {
		t.Fatalf("every signal should total one, with a reason each: %v %v", all, evidence)
	}
	if capped, _ := deadConfidence(true, true, true, outlivedFull*100); capped != 1 {
		t.Fatalf("age must saturate rather than overflow: %v", capped)
	}
	young, _ := deadConfidence(true, true, true, 0)
	if young >= scrubThreshold {
		t.Fatalf("something that never outlived anything must not be scrubbable: %v", young)
	}
	half, _ := deadConfidence(false, false, false, outlivedFull/2)
	if math.Abs(half-evidenceOutlived/2) > 1e-9 {
		t.Fatalf("age should ramp rather than switch: %v", half)
	}
}

// The supervisor is the process signalled, but the child is the one holding the
// abandoned port. Without inheritance the tree can never be swept: the root
// scores too low and the child is never a root.
func TestASupervisorCarriesTheEvidenceOfTheChildItReaps(t *testing.T) {
	root := fakeProc(t,
		fakeProcess{pid: "200", name: "crewmate", ppid: 1, pages: 10,
			args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")},
			fds:  []string{scratch(deadSession, "world.zip")}},
		fakeProcess{pid: "201", name: "factorio", ppid: 200, pages: 100,
			args: []string{"/games/factorio", "--start-server", scratch(deadSession, "world.zip")},
			fds:  []string{scratch(deadSession, "world.zip"), "socket:[4242]"}},
	)
	listenOn(t, root, "4242")
	orphans := scanOrphans(root, 1000)
	supervisor, child := orphans[0], orphans[1]
	if !supervisor.Supervisor || child.Supervisor {
		t.Fatalf("wrong roots: %+v", orphans)
	}
	// The child was never adopted by a reaper -- its supervisor is still
	// alive -- so it earns everything except that signal.
	want := evidenceWorkingInDeadSession + evidenceHoldingPort + evidenceOutlived
	if math.Abs(child.Confidence-want) > 1e-9 {
		t.Fatalf("child should hold every signal but reparenting: %+v", child)
	}
	// The supervisor is reparented but holds no port, so on its own evidence
	// it falls short; it may only be swept by carrying the child's.
	alone, _ := deadConfidence(true, true, false, outlivedFull)
	if alone >= scrubThreshold {
		t.Fatalf("this test proves nothing unless the root falls short alone: %v", alone)
	}
	if supervisor.Confidence != child.Confidence {
		t.Fatalf("the signalled root must carry its subtree's evidence: %v vs %v",
			supervisor.Confidence, child.Confidence)
	}
	if supervisor.Confidence < scrubThreshold {
		t.Fatal("a tree this dead must be sweepable")
	}
}

func TestOnlyConfidentOrphansAreSignalled(t *testing.T) {
	root := fakeProc(t, fakeProcess{pid: "700", name: "tail", ppid: 1, pages: 1,
		args: []string{"tail", "-f", scratch(deadSession, "pers/factorio-current.log")},
		fds:  []string{scratch(deadSession, "pers/factorio-current.log")}})
	signalled := []int{}
	s := newScrubber(root, 1000, newLedger(""))
	s.signal = func(pid int, sig syscall.Signal) error { signalled = append(signalled, pid); return nil }
	result := s.scrub()
	if len(signalled) != 0 || result.Minted != 0 {
		t.Fatalf("an uncertain body must be shown, not killed: signalled %v, %+v", signalled, result)
	}
	if len(scanOrphans(root, 1000)) != 1 {
		t.Fatal("and it must still be reported so the tank can show the doubt")
	}
}

// Free currency: a body that leaves on its own still hands back its memory,
// and that residue is harvestable without anyone having authority to kill.
func TestSalvagePaysForBodiesThatLeftOnTheirOwn(t *testing.T) {
	pageSize := uint64(os.Getpagesize())
	pages := int(16 * (1 << 20) / pageSize)
	populated := fakeProc(t, fakeProcess{pid: "800", name: "crewmate", ppid: 1, pages: pages,
		args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")}})
	s := newScrubber(populated, 1000, newLedger(""))
	s.now = func() time.Time { return time.Unix(0, 0).UTC() }
	if got := s.payload(); got.SalvageBytes != 0 {
		t.Fatalf("a body still present owes nothing: %v", got.SalvageBytes)
	}
	// It exits of its own accord between sweeps.
	s.root = t.TempDir()
	if got := s.payload(); got.SalvageBytes == 0 {
		t.Fatal("memory freed without a kill must become harvestable")
	}
	minted, bytes := s.harvest()
	if minted != 16 || bytes != 16*(1<<20) {
		t.Fatalf("salvage mints per mebibyte like any other mote: %v %v", minted, bytes)
	}
	if again, _ := s.harvest(); again != 0 {
		t.Fatal("a harvest must not pay twice")
	}
}

// The bytes of something the scrubber itself killed were already minted as a
// reclaim; seeing it vanish afterwards must not mint them a second time.
func TestWhatTheScrubberKilledIsNeverAlsoSalvaged(t *testing.T) {
	pageSize := uint64(os.Getpagesize())
	pages := int(32 * (1 << 20) / pageSize)
	root := fakeProc(t, fakeProcess{pid: "900", name: "crewmate", ppid: 1, pages: pages,
		args: []string{"./crewmate", "-save", scratch(deadSession, "world.zip")},
		fds:  []string{scratch(deadSession, "world.zip"), "socket:[7]"}})
	listenOn(t, root, "7")
	s := newScrubber(root, 1000, newLedger(""))
	s.now = func() time.Time { return time.Unix(0, 0).UTC() }
	s.signal = func(pid int, sig syscall.Signal) error { return nil }
	result := s.scrub()
	if result.Kind != "reclaimed" || result.Minted != 32 {
		t.Fatalf("a kill mints as a reclaim: %+v", result)
	}
	s.root = t.TempDir() // the signalled process is now gone
	s.payload()
	if minted, _ := s.harvest(); minted != 0 {
		t.Fatalf("bytes already paid for as a reclaim must not pay again as salvage: %v", minted)
	}
}
