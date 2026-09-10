package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func statFixture(name string, ticks, start uint64) string {
	f := strings.Fields("S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 5")
	f[11] = fmt.Sprint(ticks)
	f[19] = fmt.Sprint(start)
	return "123 (" + name + ") " + strings.Join(f, " ")
}
func TestParsers(t *testing.T) {
	p, err := parseProcess(statFixture("worker (child)", 42, 90), "Threads: 7\n", 4096)
	if err != nil || p.name != "worker (child)" || p.ticks != 42 || p.rss != 20480 || p.threads != 7 || p.start != "90" {
		t.Fatalf("bad process: %+v %v", p, err)
	}
	if _, err := parseProcess("gone", "", 4096); err == nil {
		t.Fatal("malformed process accepted")
	}
	nets := parseNetwork("lo: 10 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0\neth0: 30 0 0 0 0 0 0 0 40 0 0 0 0 0 0 0")
	if len(nets) != 1 || nets["eth0"].a != 30 || nets["eth0"].b != 40 {
		t.Fatal(nets)
	}
	mounts := parseMounts("1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 0 8:1 / /home rw - ext4 /dev/sda1 rw\n3 0 8:2 / /media/Work\\040Disk rw - ext4 /dev/sda2 rw\n4 0 7:0 / /snap/app rw - squashfs /dev/loop0 ro")
	if len(mounts) != 2 || mounts[1].path != "/media/Work Disk" {
		t.Fatal(mounts)
	}
	disk := parseDiskCounters("8 1 sda1 0 0 100 0 0 0 200 0 0 0 0")["8:1"]
	if disk.a != 51200 || disk.b != 102400 {
		t.Fatal(disk)
	}
	if rate(4, 8, 1, true) != nil || rate(8, 4, 0, true) != nil || rate(8, 4, 1, false) != nil {
		t.Fatal("invalid rate accepted")
	}
}
func TestSamplingAndPIDReuse(t *testing.T) {
	root := t.TempDir()
	put := func(name, text string) {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	put("stat", "cpu 100 0 0 900 0 0 0 0 999 999\n")
	put("meminfo", "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 80 kB\n")
	put("pressure/memory", "some avg10=2.00 avg60=0 total=10\nfull avg10=1.00\n")
	put("vmstat", "pswpin 10\npswpout 20\n")
	put("net/dev", "eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n")
	put("diskstats", "8 1 sda1 0 0 100 0 0 0 200 0 0 0 0\n")
	put("self/mountinfo", "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n")
	for _, pid := range []string{"10", "11", "12"} {
		uid := 1000
		if pid == "12" {
			uid = 0
		}
		put(pid+"/status", fmt.Sprintf("Uid: %d %d %d %d\nThreads: 2\n", uid, uid, uid, uid))
		put(pid+"/stat", statFixture("worker (child)", 10, 1))
	}
	c := newCollector(root, 1000)
	at := time.Unix(100, 0)
	c.update(at)
	if c.snapshot.CPU != nil || c.snapshot.Network[0].RX != nil || len(c.snapshot.Processes) != 1 || c.snapshot.Processes[0].Count != 2 {
		t.Fatalf("first sample: %+v", c.snapshot)
	}
	put("stat", "cpu 130 0 0 970 0 0 0 0\n")
	put("10/stat", statFixture("worker (child)", 30, 1))
	put("11/stat", statFixture("worker (child)", 20, 1))
	put("net/dev", "eth0: 300 0 0 0 0 0 0 0 600 0 0 0 0 0 0 0\n")
	c.update(at.Add(2 * time.Second))
	s := c.snapshot
	if math.Abs(*s.Processes[0].CPU-.3) > 1e-9 || *s.Network[0].RX != 100 || *s.Network[0].TX != 200 || *s.Memory.Used != .6 || *s.Memory.Pressure != .02 {
		t.Fatalf("wrong rates %+v", s)
	}
	first := httptest.NewRecorder()
	c.serve(first, httptest.NewRequest("GET", "/", nil))
	second := httptest.NewRecorder()
	c.serve(second, httptest.NewRequest("GET", "/", nil))
	if first.Body.String() != second.Body.String() {
		t.Fatal("clients changed sampling intervals")
	}
	if !json.Valid(first.Body.Bytes()) {
		t.Fatal(first.Body.String())
	}
	put("stat", "cpu 160 0 0 1040 0 0 0 0\n")
	put("10/stat", statFixture("worker (child)", 9000, 2))
	put("net/dev", "eth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n")
	c.update(at.Add(3 * time.Second))
	if *c.snapshot.Processes[0].CPU != 0 || c.snapshot.Network[0].RX != nil {
		t.Fatal("PID reuse or counter reset caused spike")
	}
	bad := httptest.NewRecorder()
	c.serve(bad, httptest.NewRequest("POST", "/", nil))
	if bad.Code != 405 {
		t.Fatal(bad.Code)
	}
}
func TestUnavailable(t *testing.T) {
	c := newCollector(t.TempDir(), 1000)
	c.update(time.Now())
	if c.snapshot.CPU != nil || c.snapshot.Memory.Used != nil || len(c.snapshot.Unavailable) == 0 {
		t.Fatal("missing telemetry shown as valid")
	}
}
