package main

import (
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ProcessGroup struct {
	Name    string   `json:"name"`
	Count   int      `json:"count"`
	Threads int      `json:"threads"`
	Running int      `json:"running"`
	RSS     uint64   `json:"rssBytes"`
	CPU     *float64 `json:"cpu"` // Fraction of total machine CPU capacity.
}
type Memory struct {
	Used      *float64 `json:"used"`
	Pressure  *float64 `json:"pressure"` // PSI some avg10, divided by 100.
	SwapBytes *float64 `json:"swapBytes"`
	SwapIn    *float64 `json:"swapInBytesPerSec"`
	SwapOut   *float64 `json:"swapOutBytesPerSec"`
}
type Network struct {
	Name string   `json:"name"`
	RX   *float64 `json:"rxBytesPerSec"`
	TX   *float64 `json:"txBytesPerSec"`
}
type Disk struct {
	ID        string   `json:"id"`
	Mount     string   `json:"mount"`
	Total     uint64   `json:"totalBytes"`
	Available uint64   `json:"availableBytes"`
	Used      float64  `json:"used"`
	Read      *float64 `json:"readBytesPerSec"`
	Write     *float64 `json:"writeBytesPerSec"`
}
type Ecosystem struct {
	Version     int            `json:"version"`
	SampledAt   time.Time      `json:"sampledAt"`
	CPU         *float64       `json:"cpu"`
	Memory      Memory         `json:"memory"`
	Processes   []ProcessGroup `json:"processes"`
	Network     []Network      `json:"network"`
	Disks       []Disk         `json:"disks"`
	Unavailable []string       `json:"unavailable"`
}
type procSample struct {
	name, state, start string
	ticks, rss         uint64
	threads            int
}
type counters struct{ a, b uint64 }
type collector struct {
	sync.RWMutex
	root           string
	uid            int
	snapshot       Ecosystem
	at             time.Time
	total, idle    uint64
	processes      map[string]procSample
	network, disks map[string]counters
	swap           counters
	swapOK         bool
}

func newCollector(root string, uid int) *collector { return &collector{root: root, uid: uid} }
func (c *collector) current() Ecosystem {
	c.RLock()
	defer c.RUnlock()
	return c.snapshot
}
func number(s string) uint64   { n, _ := strconv.ParseUint(s, 10, 64); return n }
func point(n float64) *float64 { return &n }
func rate(current, previous uint64, seconds float64, valid bool) *float64 {
	if !valid || seconds <= 0 || current < previous {
		return nil
	}
	return point(float64(current-previous) / seconds)
}
func fieldsMap(text string) map[string]uint64 {
	result := map[string]uint64{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			result[strings.TrimSuffix(f[0], ":")] = number(f[1])
		}
	}
	return result
}
func parseProcess(stat string, status string, pageSize uint64) (procSample, error) {
	begin, end := strings.Index(stat, "("), strings.LastIndex(stat, ")")
	if begin < 0 || end <= begin {
		return procSample{}, fmt.Errorf("invalid process stat")
	}
	f := strings.Fields(stat[end+1:])
	if len(f) < 22 {
		return procSample{}, fmt.Errorf("short process stat")
	}
	rss, err := strconv.ParseInt(f[21], 10, 64)
	if err != nil || rss < 0 {
		return procSample{}, fmt.Errorf("invalid RSS")
	}
	return procSample{name: stat[begin+1 : end], state: f[0], start: f[19], ticks: number(f[11]) + number(f[12]), rss: uint64(rss) * pageSize, threads: int(fieldsMap(status)["Threads"])}, nil
}
func parseNetwork(text string) map[string]counters {
	out := map[string]counters{}
	for _, line := range strings.Split(text, "\n") {
		pair := strings.SplitN(line, ":", 2)
		if len(pair) != 2 {
			continue
		}
		name := strings.TrimSpace(pair[0])
		f := strings.Fields(pair[1])
		if len(f) < 16 || name == "lo" {
			continue
		}
		out[name] = counters{number(f[0]), number(f[8])}
	}
	return out
}
func parseDiskCounters(text string) map[string]counters {
	out := map[string]counters{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 10 {
			out[f[0]+":"+f[1]] = counters{number(f[5]) * 512, number(f[9]) * 512}
		}
	}
	return out
}

type mount struct{ id, path string }

func parseMounts(text string) []mount {
	out := []mount{}
	seen := map[string]bool{}
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for _, line := range strings.Split(text, "\n") {
		halves := strings.SplitN(line, " - ", 2)
		if len(halves) != 2 {
			continue
		}
		f, right := strings.Fields(halves[0]), strings.Fields(halves[1])
		if len(f) < 6 || len(right) < 2 {
			continue
		}
		if seen[f[2]] || right[0] == "squashfs" || (!strings.HasPrefix(right[1], "/dev/") && f[4] != "/") {
			continue
		}
		seen[f[2]] = true
		out = append(out, mount{f[2], unescape.Replace(f[4])})
	}
	return out
}
func (c *collector) read(name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(c.root, name))
	return string(b), err
}
func (c *collector) update(now time.Time) {
	// One sampler owns counters; clients only read the published snapshot.
	seconds := now.Sub(c.at).Seconds()
	out := Ecosystem{Version: 1, SampledAt: now, Processes: []ProcessGroup{}, Network: []Network{}, Disks: []Disk{}, Unavailable: []string{}}
	total, idle := uint64(0), uint64(0)
	if text, err := c.read("stat"); err == nil {
		f := strings.Fields(strings.SplitN(text, "\n", 2)[0])
		for i := 1; i < len(f) && i <= 8; i++ {
			v := number(f[i])
			total += v
			if i == 4 || i == 5 {
				idle += v
			}
		}
		if c.total > 0 && total > c.total && idle >= c.idle {
			out.CPU = point(math.Max(0, 1-float64(idle-c.idle)/float64(total-c.total)))
		}
	} else {
		out.Unavailable = append(out.Unavailable, "cpu")
	}
	if text, err := c.read("meminfo"); err == nil {
		m := fieldsMap(text)
		if available, ok := m["MemAvailable"]; ok && m["MemTotal"] > 0 {
			out.Memory.Used = point(1 - float64(available)/float64(m["MemTotal"]))
		}
		if total, ok := m["SwapTotal"]; ok && total >= m["SwapFree"] {
			out.Memory.SwapBytes = point(float64(total-m["SwapFree"]) * 1024)
		}
	} else {
		out.Unavailable = append(out.Unavailable, "memory")
	}
	if text, err := c.read("pressure/memory"); err == nil {
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(line, "some ") {
				for _, f := range strings.Fields(line) {
					if strings.HasPrefix(f, "avg10=") {
						v, e := strconv.ParseFloat(strings.TrimPrefix(f, "avg10="), 64)
						if e == nil {
							out.Memory.Pressure = point(v / 100)
						}
					}
				}
			}
		}
	} else {
		out.Unavailable = append(out.Unavailable, "memory pressure")
	}
	if text, err := c.read("vmstat"); err == nil {
		m := fieldsMap(text)
		next := counters{m["pswpin"] * uint64(os.Getpagesize()), m["pswpout"] * uint64(os.Getpagesize())}
		out.Memory.SwapIn = rate(next.a, c.swap.a, seconds, c.swapOK)
		out.Memory.SwapOut = rate(next.b, c.swap.b, seconds, c.swapOK)
		c.swap = next
		c.swapOK = true
	} else {
		c.swapOK = false
		out.Unavailable = append(out.Unavailable, "swap activity")
	}
	nextProcesses := map[string]procSample{}
	groups := map[string]*ProcessGroup{}
	entries, err := os.ReadDir(c.root)
	if err != nil {
		out.Unavailable = append(out.Unavailable, "processes")
	}
	for _, entry := range entries {
		pid := entry.Name()
		if _, err := strconv.Atoi(pid); err != nil {
			continue
		}
		status, err := c.read(pid + "/status")
		if err != nil {
			continue
		}
		uid, ok := fieldsMap(status)["Uid"]
		if !ok || int(uid) != c.uid {
			continue
		}
		stat, err := c.read(pid + "/stat")
		if err != nil {
			continue
		}
		p, err := parseProcess(stat, status, uint64(os.Getpagesize()))
		if err != nil {
			continue
		}
		nextProcesses[pid] = p
		g := groups[p.name]
		if g == nil {
			g = &ProcessGroup{Name: p.name}
			if total > c.total && c.total > 0 {
				g.CPU = point(0)
			}
			groups[p.name] = g
		}
		g.Count++
		g.RSS += p.rss
		g.Threads += p.threads
		if p.state == "R" {
			g.Running++
		}
		previous, ok := c.processes[pid]
		if ok && previous.start == p.start && p.ticks >= previous.ticks && g.CPU != nil {
			*g.CPU += float64(p.ticks-previous.ticks) / float64(total-c.total)
		}
	}
	for _, g := range groups {
		out.Processes = append(out.Processes, *g)
	}
	sort.Slice(out.Processes, func(i, j int) bool { return out.Processes[i].Name < out.Processes[j].Name })
	if text, err := c.read("net/dev"); err == nil {
		next := parseNetwork(text)
		for name, v := range next {
			prev, ok := c.network[name]
			out.Network = append(out.Network, Network{name, rate(v.a, prev.a, seconds, ok), rate(v.b, prev.b, seconds, ok)})
		}
		c.network = next
		sort.Slice(out.Network, func(i, j int) bool { return out.Network[i].Name < out.Network[j].Name })
	} else {
		c.network = nil
		out.Unavailable = append(out.Unavailable, "network")
	}
	diskText, diskErr := c.read("diskstats")
	diskCounters := parseDiskCounters(diskText)
	if text, err := c.read("self/mountinfo"); err == nil {
		for _, m := range parseMounts(text) {
			var fs syscall.Statfs_t
			if syscall.Statfs(m.path, &fs) != nil || fs.Blocks == 0 {
				continue
			}
			d := Disk{ID: m.id, Mount: m.path, Total: fs.Blocks * uint64(fs.Bsize), Available: fs.Bavail * uint64(fs.Bsize), Used: 1 - float64(fs.Bavail)/float64(fs.Blocks)}
			next, exists := diskCounters[m.id]
			prev, ok := c.disks[m.id]
			d.Read = rate(next.a, prev.a, seconds, exists && ok && diskErr == nil)
			d.Write = rate(next.b, prev.b, seconds, exists && ok && diskErr == nil)
			out.Disks = append(out.Disks, d)
		}
	} else {
		out.Unavailable = append(out.Unavailable, "filesystems")
	}
	if diskErr != nil {
		out.Unavailable = append(out.Unavailable, "disk activity")
	}
	c.at, c.total, c.idle, c.processes, c.disks = now, total, idle, nextProcesses, diskCounters
	c.Lock()
	c.snapshot = out
	c.Unlock()
}
func (c *collector) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	c.RLock()
	snapshot := c.snapshot
	c.RUnlock()
	writeJSON(w, 200, snapshot)
}
