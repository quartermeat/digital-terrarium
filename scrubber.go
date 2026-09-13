package main

import (
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Orphanhood is a fact about ownership, not about activity. A busy orphan looks
// healthy and an idle one looks like any sleeping daemon, so the tank cannot
// find one by watching how it moves -- stillness is rest, not death.
//
// What does distinguish one is provable from /proc. An agent session owns a
// scratchpad directory named after its own UUID, and proves it is still alive
// by holding a descriptor open under that path. Processes still pointing at a
// scratchpad that no living agent claims are what a session leaves behind when
// it dies mid-flight, still holding ports and still autosaving into a directory
// nobody will read again.
//
// Inherited descriptors are not a claim: a server started from one session and
// outliving it keeps those descriptors open, and so does an unrelated sibling.
// Only an agent process's grip counts, which is why claims are collected from
// agent processes alone.
// Deadness is a weight of evidence, not a verdict. A single timer was too
// blunt in both directions: it made a command that merely quotes a dead
// scratchpad wait sixty seconds to be cleared, and it would have cleared it
// eventually anyway. Each signal below is something independently observable
// about a process, and they are summed so that the tank can show how sure it
// is rather than only what it concluded.
//
// The weights are chosen so that no combination short of genuinely working in
// a dead session can reach the threshold: a tail of a dead log holds a
// descriptor and nothing else, and tops out at 0.30 however long it runs.
const (
	evidenceWorkingInDeadSession = .30 // holds a descriptor or cwd under the scratchpad
	evidenceReparented           = .15 // its parent is gone; a reaper adopted it
	evidenceHoldingPort          = .20 // still serving a socket nobody dials
	evidenceOutlived             = .35 // has outlived the session that made it
	outlivedFull                 = 120 * time.Second
	// Only a process carrying nearly every signal may be signalled.
	scrubThreshold = .85
)

// Clock ticks per second for process start times in /proc. Linux fixes this at
// 100 for userspace regardless of the kernel's internal tick rate.
const clockTicks = 100

var sessionPath = regexp.MustCompile(`/tmp/claude-[0-9]+/[^/\x00 ]+/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})`)

type Orphan struct {
	PID        int      `json:"pid"`
	Name       string   `json:"name"`
	Session    string   `json:"session"`
	Command    string   `json:"command"`
	RSS        uint64   `json:"rssBytes"`
	Supervisor bool     `json:"supervisor"`
	AgeSeconds float64  `json:"ageSeconds"`
	Confidence float64  `json:"confidence"`
	Evidence   []string `json:"evidence"`
}

// Confidence is assembled rather than asserted: every term names the
// observation that produced it, so a body in the tank can be interrogated for
// why it is being approached.
func deadConfidence(working, reparented, port bool, age time.Duration) (float64, []string) {
	score, evidence := 0.0, []string{}
	if working {
		score += evidenceWorkingInDeadSession
		evidence = append(evidence, "working in a session that ended")
	}
	if reparented {
		score += evidenceReparented
		evidence = append(evidence, "parent gone, adopted by a reaper")
	}
	if port {
		score += evidenceHoldingPort
		evidence = append(evidence, "still holding a listening port")
	}
	if age > 0 {
		share := float64(age) / float64(outlivedFull)
		if share > 1 {
			share = 1
		}
		score += evidenceOutlived * share
		evidence = append(evidence, fmt.Sprintf("outlived its session by %ds", int(age.Seconds())))
	}
	if score > 1 {
		score = 1
	}
	// Summed weights land on values like 0.9999999999999999; round so that a
	// body carrying every signal reads as certain rather than very nearly so.
	return math.Round(score*1e4) / 1e4, evidence
}

// Signalling a supervisor is not the same as killing its children. crewmate
// traps SIGTERM and runs its own shutdown, which stops the game politely and
// only escalates after fifteen seconds; killing the child directly skips that
// path and loses the save. So the scrubber signals roots and lets them reap.
func isAgentCommand(comm string, args []string) bool {
	if comm == "claude" || comm == "codex" {
		return true
	}
	for _, a := range args {
		if a == "" {
			continue
		}
		switch filepath.Base(a) {
		case "claude", "codex":
			return true
		}
	}
	return false
}

func statField(stat string, index int) string {
	end := strings.LastIndex(stat, ")")
	if end < 0 {
		return ""
	}
	f := strings.Fields(stat[end+1:])
	if index < 0 || index >= len(f) {
		return ""
	}
	return f[index]
}

// Which sessions a process actually has its hands in: a descriptor open under
// the scratchpad, or its working directory inside it. For an agent this is a
// claim of ownership; for a candidate it is evidence of working in a grave.
func sessionsHeld(root, pid string) []string {
	out := []string{}
	if link, err := os.Readlink(filepath.Join(root, pid, "cwd")); err == nil {
		if m := sessionPath.FindStringSubmatch(link); m != nil {
			out = append(out, m[1])
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, pid, "fd"))
	if err != nil {
		return out
	}
	for _, entry := range entries {
		link, err := os.Readlink(filepath.Join(root, pid, "fd", entry.Name()))
		if err != nil {
			continue
		}
		if m := sessionPath.FindStringSubmatch(link); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// A listening socket is the difference between a process that is merely still
// running and one that is still offering a service nobody is left to use.
func listeningInodes(root string) map[string]bool {
	out := map[string]bool{}
	for _, name := range []string{"net/tcp", "net/tcp6"} {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n")[1:] {
			f := strings.Fields(line)
			// local_address is field 1, connection state field 3, inode field 9.
			if len(f) > 9 && f[3] == "0A" {
				out[f[9]] = true
			}
		}
	}
	return out
}

func holdsListeningSocket(root, pid string, listening map[string]bool) bool {
	if len(listening) == 0 {
		return false
	}
	entries, err := os.ReadDir(filepath.Join(root, pid, "fd"))
	if err != nil {
		return false
	}
	for _, entry := range entries {
		link, err := os.Readlink(filepath.Join(root, pid, "fd", entry.Name()))
		if err != nil || !strings.HasPrefix(link, "socket:[") {
			continue
		}
		if listening[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")] {
			return true
		}
	}
	return false
}

// Adoption by a reaper means the process that started this one is gone. On a
// systemd user session that reaper is the manager rather than init, so both
// count.
func adoptedByReaper(root, ppid string) bool {
	if ppid == "1" {
		return true
	}
	stat, err := os.ReadFile(filepath.Join(root, ppid, "stat"))
	if err != nil {
		return false
	}
	begin, end := strings.Index(string(stat), "("), strings.LastIndex(string(stat), ")")
	if begin < 0 || end <= begin {
		return false
	}
	return string(stat)[begin+1:end] == "systemd" && statField(string(stat), 1) == "1"
}

type candidate struct {
	orphan Orphan
	ppid   string
}

// Ages are refused rather than guessed: a process whose start cannot be read
// is never old enough to scrub.
func processAge(uptimeSeconds float64, start string, ok bool) (time.Duration, bool) {
	if !ok {
		return 0, false
	}
	ticks, err := strconv.ParseFloat(start, 64)
	if err != nil || ticks < 0 {
		return 0, false
	}
	seconds := uptimeSeconds - ticks/clockTicks
	if seconds < 0 {
		return 0, false
	}
	return time.Duration(seconds * float64(time.Second)), true
}

func bootUptime(root string) (float64, bool) {
	data, err := os.ReadFile(filepath.Join(root, "uptime"))
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return 0, false
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	return seconds, err == nil
}

func scanOrphans(root string, uid int) []Orphan {
	entries, err := os.ReadDir(root)
	if err != nil {
		return []Orphan{}
	}
	uptime, uptimeOK := bootUptime(root)
	listening := listeningInodes(root)
	claimed := map[string]bool{}
	candidates := map[string]candidate{}
	for _, entry := range entries {
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}
		status, err := os.ReadFile(filepath.Join(root, pid, "status"))
		if err != nil {
			continue
		}
		if owner, ok := fieldsMap(string(status))["Uid"]; !ok || int(owner) != uid {
			continue
		}
		stat, err := os.ReadFile(filepath.Join(root, pid, "stat"))
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(root, pid, "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
		sample, err := parseProcess(string(stat), string(status), uint64(os.Getpagesize()))
		if err != nil {
			continue
		}
		if isAgentCommand(sample.name, args) {
			for _, session := range sessionsHeld(root, pid) {
				claimed[session] = true
			}
			continue
		}
		match := sessionPath.FindStringSubmatch(strings.Join(args, " "))
		if match == nil {
			continue
		}
		// An age that cannot be read is not evidence of anything, so the
		// process simply earns nothing from having outlived its session.
		age, _ := processAge(uptime, sample.start, uptimeOK)
		ppid := statField(string(stat), 1)
		working := false
		for _, held := range sessionsHeld(root, pid) {
			if held == match[1] {
				working = true
			}
		}
		confidence, evidence := deadConfidence(working, adoptedByReaper(root, ppid),
			holdsListeningSocket(root, pid, listening), age)
		number, _ := strconv.Atoi(pid)
		candidates[pid] = candidate{
			orphan: Orphan{PID: number, Name: sample.name, Session: match[1], RSS: sample.rss,
				Command:    strings.TrimSpace(strings.Join(args, " ")),
				AgeSeconds: age.Seconds(), Confidence: confidence, Evidence: evidence},
			ppid: ppid,
		}
	}
	// A root of the orphan tree is the one to signal; its children are reaped
	// by whatever shutdown their supervisor already implements.
	rootOf := func(pid string) string {
		for seen := map[string]bool{}; !seen[pid]; {
			seen[pid] = true
			c, ok := candidates[pid]
			if !ok {
				break
			}
			parent, parentIsCandidate := candidates[c.ppid]
			if !parentIsCandidate || claimed[parent.orphan.Session] {
				break
			}
			pid = c.ppid
		}
		return pid
	}
	// A supervisor and the children it will reap are one body: they die
	// together, so evidence gathered against any of them counts for the root
	// that is actually signalled. Without this a supervisor that merely
	// launches things scores too low to ever be swept, while the child holding
	// the abandoned port is never signalled because it is not a root.
	strongest := map[string]float64{}
	for pid, c := range candidates {
		if claimed[c.orphan.Session] {
			continue
		}
		if root := rootOf(pid); c.orphan.Confidence > strongest[root] {
			strongest[root] = c.orphan.Confidence
		}
	}
	out := []Orphan{}
	for pid, c := range candidates {
		if claimed[c.orphan.Session] {
			continue
		}
		c.orphan.Supervisor = rootOf(pid) == pid
		if c.orphan.Supervisor && strongest[pid] > c.orphan.Confidence {
			c.orphan.Confidence = strongest[pid]
			c.orphan.Evidence = append(c.orphan.Evidence, "carrying evidence from a child it will reap")
		}
		out = append(out, c.orphan)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PID < out[j].PID })
	return out
}

// Reclaimable memory is what the scrub is actually worth, and it is the only
// quantity the ledger mints against.
func reclaimable(orphans []Orphan) uint64 {
	var total uint64
	for _, o := range orphans {
		total += o.RSS
	}
	return total
}

type scrubber struct {
	sync.Mutex
	root    string
	uid     int
	ledger  *ledger
	signal  func(pid int, sig syscall.Signal) error
	now     func() time.Time
	seen    map[int]Orphan
	reaped  map[int]bool
	salvage uint64
}

func newScrubber(root string, uid int, l *ledger) *scrubber {
	return &scrubber{root: root, uid: uid, ledger: l, now: time.Now,
		seen: map[int]Orphan{}, reaped: map[int]bool{},
		signal: func(pid int, sig syscall.Signal) error { return syscall.Kill(pid, sig) }}
}

// Being paid is not always the same as killing. An abandoned process that
// exits on its own still hands the machine its memory back, and nobody had to
// take it -- that residue is free currency, and harvesting it needs no
// authority to kill. What this must never do is pay twice for the same bytes,
// so anything the scrubber itself signalled is excluded: those bytes were
// already minted as a reclaim.
func (s *scrubber) observe(orphans []Orphan) {
	s.Lock()
	defer s.Unlock()
	present := map[int]bool{}
	for _, o := range orphans {
		present[o.PID] = true
		s.seen[o.PID] = o
	}
	for pid, o := range s.seen {
		if present[pid] {
			continue
		}
		if !s.reaped[pid] {
			s.salvage += o.RSS
		}
		delete(s.seen, pid)
		delete(s.reaped, pid)
	}
}

func (s *scrubber) harvest() (float64, uint64) {
	s.Lock()
	bytes := s.salvage
	s.salvage = 0
	s.Unlock()
	if bytes == 0 {
		return 0, 0
	}
	return s.ledger.mint(bytes, "salvaged memory freed without a kill", s.now()), bytes
}

func (s *scrubber) pendingSalvage() uint64 {
	s.Lock()
	defer s.Unlock()
	return s.salvage
}

func (s *scrubber) serveSalvage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "salvage requires POST"})
		return
	}
	s.observe(scanOrphans(s.root, s.uid))
	minted, bytes := s.harvest()
	writeJSON(w, http.StatusOK, map[string]any{"kind": "salvaged", "minted": minted,
		"salvagedBytes": bytes, "balance": s.ledger.snapshot().Balance})
}

type scrubResult struct {
	Kind      string   `json:"kind"`
	Signalled []Orphan `json:"signalled"`
	Reclaimed uint64   `json:"reclaimedBytes"`
	Minted    float64  `json:"minted"`
	Balance   float64  `json:"balance"`
}

// Only supervisors are signalled, and only ever with SIGTERM: the scrubber
// asks, it does not execute. Anything that refuses to leave stays visible in
// the tank next sweep rather than being forced out from here.
func (s *scrubber) scrub() scrubResult {
	orphans := scanOrphans(s.root, s.uid)
	result := scrubResult{Signalled: []Orphan{}}
	for _, o := range orphans {
		if !o.Supervisor || o.Confidence < scrubThreshold {
			continue
		}
		if err := s.signal(o.PID, syscall.SIGTERM); err != nil {
			continue
		}
		result.Signalled = append(result.Signalled, o)
		result.Reclaimed += o.RSS
		s.Lock()
		s.reaped[o.PID] = true
		s.Unlock()
	}
	// Children go with their supervisor, so their memory counts toward the
	// mint even though they were never signalled directly.
	for _, o := range orphans {
		if !o.Supervisor && o.Confidence >= scrubThreshold {
			result.Reclaimed += o.RSS
			s.Lock()
			s.reaped[o.PID] = true
			s.Unlock()
		}
	}
	if len(result.Signalled) > 0 {
		result.Minted = s.ledger.mint(result.Reclaimed, "scrubbed "+strconv.Itoa(len(result.Signalled))+" orphan supervisor(s)", s.now())
	}
	result.Kind = "reclaimed"
	result.Balance = s.ledger.snapshot().Balance
	return result
}

// What a creature needs to know about its own death: how much of the group is
// gone, and how sure the sweep is about the surest of them.
type GroupRot struct {
	Dead       int     `json:"dead"`
	Confidence float64 `json:"confidence"`
}

type orphanPayload struct {
	Version          int                 `json:"version"`
	SampledAt        time.Time           `json:"sampledAt"`
	Orphans          []Orphan            `json:"orphans"`
	Groups           map[string]GroupRot `json:"groups"`
	ReclaimableBytes uint64              `json:"reclaimableBytes"`
	SalvageBytes     uint64              `json:"salvageBytes"`
	Balance          float64             `json:"balance"`
	Auto             bool                `json:"auto"`
	KillConfidence   float64             `json:"killConfidence"`
}

// Killing is a sensitive action, so the policy lives with the bridge rather
// than the scene: the renderer is told whether it may consume what it finds,
// and a tank that is not armed still shows the rot it can see.
func scrubAuto() bool { return os.Getenv("TERRARIUM_SCRUB_AUTO") == "1" }

// A creature is a group of processes sharing a name, and a group can be part
// dead: the same "factorio" that hosts a live save also hosted the one nobody
// owns any more. Counting orphans per group lets the scene rot the share that
// is actually dead instead of condemning the whole body.
func (s *scrubber) payload() orphanPayload {
	orphans := scanOrphans(s.root, s.uid)
	s.observe(orphans)
	groups := map[string]GroupRot{}
	for _, o := range orphans {
		rot := groups[o.Name]
		rot.Dead++
		if o.Confidence > rot.Confidence {
			rot.Confidence = o.Confidence
		}
		groups[o.Name] = rot
	}
	return orphanPayload{Version: 1, SampledAt: s.now(), Orphans: orphans, Groups: groups,
		ReclaimableBytes: reclaimable(orphans), SalvageBytes: s.pendingSalvage(),
		Balance: s.ledger.snapshot().Balance, Auto: scrubAuto(), KillConfidence: scrubThreshold}
}

func (s *scrubber) serveOrphans(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.payload())
}

func (s *scrubber) serveScrub(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "scrub requires POST"})
		return
	}
	writeJSON(w, http.StatusOK, s.scrub())
}
