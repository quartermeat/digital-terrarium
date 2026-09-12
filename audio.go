package main

import (
	"context"
	"encoding/binary"
	"io"
	"log"
	"math"
	"net/http"
	"os/exec"
	"sync"
	"time"
)

// Only monitor speaker output. Never fall back to the microphone.
type audioFrame struct {
	Available bool        `json:"available"`
	SampledAt time.Time   `json:"sampledAt"`
	Level     float64     `json:"level"`
	Bass      float64     `json:"bass"`
	Waveform  [40]float64 `json:"waveform"`
}
type audioMonitor struct {
	mu    sync.RWMutex
	frame audioFrame
}

func analyzeAudio(pcm []byte, low *float64) audioFrame {
	f := audioFrame{Available: true, SampledAt: time.Now()}
	n := len(pcm) / 2
	if n == 0 {
		return f
	}
	var energy, bass float64
	for i := 0; i < n; i++ {
		v := float64(int16(binary.LittleEndian.Uint16(pcm[i*2:]))) / 32768
		energy += v * v
		*low += .06 * (v - *low)
		bass += *low * *low
		bin := i * len(f.Waveform) / n
		if math.Abs(v) > math.Abs(f.Waveform[bin]) {
			f.Waveform[bin] = v
		}
	}
	f.Level = math.Min(1, math.Sqrt(energy/float64(n))*3)
	f.Bass = math.Min(1, math.Sqrt(bass/float64(n))*4)
	return f
}
func (a *audioMonitor) capture(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "parec", "--device=@DEFAULT_MONITOR@", "--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=50", "--client-name=Terrarium music waves")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err = cmd.Start(); err != nil {
		return err
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	buf := make([]byte, 1600) // 50 ms; raw sound is discarded after analysis.
	var low float64
	for {
		if _, err = io.ReadFull(stdout, buf); err != nil {
			return err
		}
		frame := analyzeAudio(buf, &low)
		a.mu.Lock()
		a.frame = frame
		a.mu.Unlock()
	}
}
func (a *audioMonitor) run(ctx context.Context) {
	for ctx.Err() == nil {
		err := a.capture(ctx)
		a.mu.Lock()
		a.frame = audioFrame{}
		a.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		log.Printf("Speaker monitor unavailable: %v", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}
func (a *audioMonitor) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.RLock()
	frame := a.frame
	a.mu.RUnlock()
	if time.Since(frame.SampledAt) > time.Second {
		frame = audioFrame{}
	}
	writeJSON(w, http.StatusOK, frame)
}
