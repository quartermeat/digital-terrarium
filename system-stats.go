package main

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
)

var cpuSample struct {
	sync.Mutex
	total, idle uint64
}

func systemStatsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	result := map[string]any{}
	if data, err := os.ReadFile("/proc/stat"); err == nil {
		fields := strings.Fields(strings.SplitN(string(data), "\n", 2)[0])
		var total, idle uint64
		for i, f := range fields[1:] {
			if i >= 8 {
				break
			}
			value, _ := strconv.ParseUint(f, 10, 64)
			total += value
			if i == 3 || i == 4 {
				idle += value
			}
		}
		cpuSample.Lock()
		if cpuSample.total > 0 && total > cpuSample.total && idle >= cpuSample.idle {
			result["cpu"] = 1 - float64(idle-cpuSample.idle)/float64(total-cpuSample.total)
		}
		cpuSample.total, cpuSample.idle = total, idle
		cpuSample.Unlock()
	}
	if data, err := os.ReadFile("/proc/meminfo"); err == nil {
		values := map[string]float64{}
		for _, line := range strings.Split(string(data), "\n") {
			var key string
			var value float64
			if _, err := fmt.Sscanf(line, "%s %f", &key, &value); err == nil {
				values[key] = value
			}
		}
		if total := values["MemTotal:"]; total > 0 {
			if available, ok := values["MemAvailable:"]; ok {
				result["memory"] = 1 - available/total
			}
		}
	}
	writeJSON(w, http.StatusOK, result)
}
