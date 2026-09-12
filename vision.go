package main

import (
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// Camera landmarks arrive from a separate renderer that owns the device, so the
// scene never pays for inference inside its own frame budget. Coordinates are
// normalized habitat space like everything else the viewer draws, already
// mirrored so moving right on camera moves right on screen.
const (
	visionHandLandmarks = 21
	visionFaceLandmarks = 136
)

type VisionPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type VisionHand struct {
	Side    string        `json:"side"`
	Score   float64       `json:"score"`
	Gesture string        `json:"gesture"`
	Speed   float64       `json:"speed"`
	Points  []VisionPoint `json:"points"`
}

// Aspect is the camera frame's width/height, which the viewer needs to keep a
// face in proportion when it paints camera space onto a wider screen.

// Span is the face width as a fraction of the frame: the viewer fades the
// wireframe in with proximity rather than snapping it on at a threshold.
type VisionFace struct {
	Score  float64       `json:"score"`
	Span   float64       `json:"span"`
	Points []VisionPoint `json:"points"`
}

type VisionFrame struct {
	Version   int          `json:"version"`
	Available bool         `json:"available"`
	SampledAt time.Time    `json:"sampledAt"`
	Camera    string       `json:"camera,omitempty"`
	Aspect    float64      `json:"aspect"`
	Hands     []VisionHand `json:"hands"`
	Face      *VisionFace  `json:"face,omitempty"`
}

var safeVisionName = regexp.MustCompile(`^[a-zA-Z0-9_. /:@+-]{0,64}$`)

// Landmarks may sit slightly outside the frame when a hand or face is half off
// camera; further than that is a bad report, not a reachable position.
func visionCoordinate(value float64) bool {
	return !math.IsNaN(value) && value >= -.5 && value <= 1.5
}

func visionPointsValid(points []VisionPoint, want int) bool {
	if len(points) != want {
		return false
	}
	for _, point := range points {
		if !visionCoordinate(point.X) || !visionCoordinate(point.Y) {
			return false
		}
	}
	return true
}

func visionScoreValid(value float64) bool {
	return !math.IsNaN(value) && value >= 0 && value <= 1
}

func validVisionHand(hand VisionHand) bool {
	if !visionPointsValid(hand.Points, visionHandLandmarks) || !safeVisionName.MatchString(hand.Gesture) ||
		!visionScoreValid(hand.Score) || math.IsNaN(hand.Speed) || hand.Speed < 0 || hand.Speed > 40 {
		return false
	}
	switch hand.Side {
	case "", "Left", "Right":
		return true
	}
	return false
}

func validVisionFrame(frame VisionFrame) bool {
	if frame.Version != 1 || len(frame.Hands) > 2 || !safeVisionName.MatchString(frame.Camera) ||
		math.IsNaN(frame.Aspect) || frame.Aspect < 0 || frame.Aspect > 10 {
		return false
	}
	for _, hand := range frame.Hands {
		if !validVisionHand(hand) {
			return false
		}
	}
	if frame.Face != nil && (!visionPointsValid(frame.Face.Points, visionFaceLandmarks) ||
		!visionScoreValid(frame.Face.Score) || !visionScoreValid(frame.Face.Span)) {
		return false
	}
	return true
}

type visionHub struct {
	mu    sync.RWMutex
	frame VisionFrame
}

// A hand or face describes a position held right now, so a feed that stops
// reporting must read as absent rather than leaving a phantom pinned to the
// last sighting. Hands expire the way in-progress agent phases do.
const visionStaleAfter = 500 * time.Millisecond

func (v *visionHub) frameNow() VisionFrame {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if !v.frame.Available || time.Since(v.frame.SampledAt) > visionStaleAfter {
		return VisionFrame{Version: 1, Hands: []VisionHand{}}
	}
	return v.frame
}

func (v *visionHub) store(frame VisionFrame) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.frame = frame
}

// Only the local machine may describe what the camera sees.
func loopbackRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func (v *visionHub) serve(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, v.frameNow())
		return
	case http.MethodPost:
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !loopbackRequest(r) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	var frame VisionFrame
	if err := json.NewDecoder(io.LimitReader(r.Body, 32768)).Decode(&frame); err != nil || !validVisionFrame(frame) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	// Stamp on arrival: one clock decides freshness, so a skewed renderer clock
	// can neither age out a live hand nor keep a dead feed looking current.
	frame.SampledAt = time.Now()
	if frame.Hands == nil {
		frame.Hands = []VisionHand{}
	}
	v.store(frame)
	w.WriteHeader(http.StatusNoContent)
}

// The models total 12 MiB and the habitat runs all day, so fetch each once and
// serve the cached copy afterwards; a restart offline still starts vision.
var visionModels = map[string]string{
	"gesture": "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task",
	"face":    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
}

var visionModelMutex sync.Mutex

func visionModelPath(name string) string {
	cache := os.Getenv("XDG_CACHE_HOME")
	if cache == "" {
		home, _ := os.UserHomeDir()
		cache = filepath.Join(home, ".cache")
	}
	return filepath.Join(cache, "digital-terrarium", name+".task")
}

func cacheVisionModel(name, path string) error {
	visionModelMutex.Lock()
	defer visionModelMutex.Unlock()
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	response, err := http.Get(visionModels[name])
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return os.ErrNotExist
	}
	// Write beside the target and rename, so an interrupted download can never
	// leave a truncated model that loads as a corrupt graph on the next start.
	temporary, err := os.CreateTemp(filepath.Dir(path), name+"-*.partial")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	if _, err = io.Copy(temporary, io.LimitReader(response.Body, 64<<20)); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), path)
}

func visionModelHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	name := r.URL.Query().Get("name")
	if _, known := visionModels[name]; !known {
		http.NotFound(w, r)
		return
	}
	path := visionModelPath(name)
	if err := cacheVisionModel(name, path); err != nil {
		http.Error(w, "Model unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, path)
}
