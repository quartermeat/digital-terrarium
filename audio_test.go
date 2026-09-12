package main

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAudioAnalysis(t *testing.T) {
	tone := func(hz float64) audioFrame {
		pcm := make([]byte, 1600)
		for i := 0; i < 800; i++ {
			binary.LittleEndian.PutUint16(pcm[i*2:], uint16(int16(8000*math.Sin(2*math.Pi*hz*float64(i)/16000))))
		}
		var low float64
		return analyzeAudio(pcm, &low)
	}
	bass, treble := tone(80), tone(3000)
	if bass.Level < .4 || bass.Bass < treble.Bass*5 {
		t.Fatalf("unexpected levels: bass=%+v treble=%+v", bass, treble)
	}
	var low float64
	silent := analyzeAudio(make([]byte, 1600), &low)
	if silent.Level != 0 || silent.Bass != 0 || silent.Waveform != [40]float64{} {
		t.Fatal("silence produced motion")
	}
	if bass.Waveform == [40]float64{} {
		t.Fatal("tone has no waveform")
	}
}

func TestAudioStale(t *testing.T) {
	a := &audioMonitor{frame: audioFrame{Available: true, SampledAt: time.Now().Add(-2 * time.Second), Level: 1}}
	response := httptest.NewRecorder()
	a.serve(response, httptest.NewRequest("GET", "/api/audio", nil))
	var frame audioFrame
	if err := json.Unmarshal(response.Body.Bytes(), &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Available || frame.Level != 0 {
		t.Fatal("stale audio still active")
	}
}
