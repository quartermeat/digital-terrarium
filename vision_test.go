package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func facePoints(n int) []VisionPoint {
	points := make([]VisionPoint, n)
	for i := range points {
		points[i] = VisionPoint{X: float64(i) / float64(n), Y: .5}
	}
	return points
}

func TestVisionFrameValidation(t *testing.T) {
	good := VisionFrame{Version: 1, Available: true, Aspect: 1.78,
		Face: &VisionFace{Score: .9, Span: .3, Points: facePoints(visionFaceLandmarks)}}
	if !validVisionFrame(good) {
		t.Fatal("a well-formed frame must validate")
	}
	for name, frame := range map[string]VisionFrame{
		"wrong version":   {Version: 2, Aspect: 1.78},
		"impossible span": {Version: 1, Face: &VisionFace{Span: 4, Points: facePoints(visionFaceLandmarks)}},
		"short face":      {Version: 1, Face: &VisionFace{Points: facePoints(12)}},
		"long face":       {Version: 1, Face: &VisionFace{Points: facePoints(478)}},
		"unruly camera":   {Version: 1, Camera: "rm -rf\n/"},
		"absurd aspect":   {Version: 1, Aspect: 99},
	} {
		if validVisionFrame(frame) {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestVisionCoordinatesStayNearTheFrame(t *testing.T) {
	frame := VisionFrame{Version: 1, Face: &VisionFace{Points: facePoints(visionFaceLandmarks)}}
	frame.Face.Points[3].X = 7
	if validVisionFrame(frame) {
		t.Fatal("a landmark far outside the frame must be rejected")
	}
}

func TestVisionHubExpiresTheSkullButServesFreshOnes(t *testing.T) {
	hub := &visionHub{}
	if hub.frameNow().Available {
		t.Fatal("an unstarted camera must not read as available")
	}
	face := &VisionFace{Span: .3, Points: facePoints(visionFaceLandmarks)}
	hub.store(VisionFrame{Version: 1, Available: true, SampledAt: time.Now(), Face: face})
	if hub.frameNow().Face == nil {
		t.Fatal("a fresh frame must be served")
	}
	hub.store(VisionFrame{Version: 1, Available: true, SampledAt: time.Now().Add(-time.Second), Face: face})
	if got := hub.frameNow(); got.Available || got.Face != nil {
		t.Fatalf("a stale skull must disappear rather than linger: %#v", got)
	}
}

func TestVisionPostStampsOnArrivalAndRejectsRemotes(t *testing.T) {
	hub := &visionHub{}
	body := `{"version":1,"available":true,"aspect":1.78,"sampledAt":"2000-01-01T00:00:00Z"}`
	request := httptest.NewRequest(http.MethodPost, "/api/vision", strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:5000"
	recorder := httptest.NewRecorder()
	hub.serve(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("local post rejected: %d", recorder.Code)
	}
	// A renderer clock must not be able to decide freshness for the habitat.
	if !hub.frameNow().Available {
		t.Fatal("an ancient source timestamp must be replaced with arrival time")
	}
	remote := httptest.NewRequest(http.MethodPost, "/api/vision", strings.NewReader(body))
	remote.RemoteAddr = "10.0.0.9:5000"
	recorder = httptest.NewRecorder()
	hub.serve(recorder, remote)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("only the local machine may describe the camera: %d", recorder.Code)
	}
}

func TestVisionPostRejectsMalformedBodies(t *testing.T) {
	hub := &visionHub{}
	oversized, _ := json.Marshal(VisionFrame{Version: 1, Available: true,
		Face: &VisionFace{Points: facePoints(4000)}})
	for name, body := range map[string]string{"not json": "{", "invalid": `{"version":3}`, "oversized": string(oversized)} {
		request := httptest.NewRequest(http.MethodPost, "/api/vision", bytes.NewReader([]byte(body)))
		request.RemoteAddr = "127.0.0.1:5000"
		recorder := httptest.NewRecorder()
		hub.serve(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s must be rejected: %d", name, recorder.Code)
		}
	}
	if hub.frameNow().Available {
		t.Fatal("a rejected body must not become the current frame")
	}
}

func TestVisionModelHandlerRefusesUnknownNames(t *testing.T) {
	recorder := httptest.NewRecorder()
	visionModelHandler(recorder, httptest.NewRequest(http.MethodGet, "/api/vision-model?name=../../etc/passwd", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("only known models may be fetched: %d", recorder.Code)
	}
}
