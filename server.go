package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Print(err)
	}
}

// One stream replaces three polling loops. Each source keeps its own cadence,
// so the viewer sees telemetry at the rate it is actually sampled rather than
// at whatever rate a client happened to ask.
func streamHandler(snapshot func() Ecosystem, audio *audioMonitor, vision *visionHub, scrub *scrubber) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
			return
		}
		header := w.Header()
		header.Set("Content-Type", "text/event-stream")
		header.Set("Cache-Control", "no-store")
		header.Set("Connection", "keep-alive")
		send := func(event string, payload any) bool {
			body, err := json.Marshal(payload)
			if err != nil {
				return false
			}
			if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, body); err != nil {
				return false
			}
			flusher.Flush()
			return true
		}
		ecosystem := time.NewTicker(time.Second)
		defer ecosystem.Stop()
		agents := time.NewTicker(500 * time.Millisecond)
		defer agents.Stop()
		sound := time.NewTicker(50 * time.Millisecond)
		defer sound.Stop()
		sight := time.NewTicker(50 * time.Millisecond)
		defer sight.Stop()
		// Ownership changes when a session ends, not frame to frame, so the
		// orphan sweep runs far slower than the feeds that describe movement.
		orphans := time.NewTicker(5 * time.Second)
		defer orphans.Stop()
		if !send("ecosystem", snapshot()) || !send("agents", agentActivityPayload()) ||
			!send("audio", audio.frameNow()) || !send("vision", vision.frameNow()) ||
			!send("orphans", scrub.payload()) {
			return
		}
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ecosystem.C:
				if !send("ecosystem", snapshot()) {
					return
				}
			case <-agents.C:
				if !send("agents", agentActivityPayload()) {
					return
				}
			case <-sound.C:
				if !send("audio", audio.frameNow()) {
					return
				}
			case <-sight.C:
				if !send("vision", vision.frameNow()) {
					return
				}
			case <-orphans.C:
				if !send("orphans", scrub.payload()) {
					return
				}
			}
		}
	}
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--fullscreen-state" {
		if err := json.NewEncoder(os.Stdout).Encode(desktopFullscreenState()); err != nil {
			log.Fatal(err)
		}
		return
	}
	// A machine-readable sweep that kills nothing, so the rule that decides
	// what counts as abandoned can be audited without starting the scene.
	if len(os.Args) == 2 && os.Args[1] == "--orphans" {
		home, _ := os.UserHomeDir()
		probe := newScrubber("/proc", os.Getuid(), newLedger(filepath.Join(home, ".local", "state", "digital-terrarium", "ledger.json")))
		if err := json.NewEncoder(os.Stdout).Encode(probe.payload()); err != nil {
			log.Fatal(err)
		}
		return
	}
	collector := newCollector("/proc", os.Getuid())
	collector.update(time.Now())
	go func() {
		for now := range time.NewTicker(time.Second).C {
			collector.update(now)
		}
	}()
	mux := http.NewServeMux()
	spotify := newSpotifyController(collector.current)
	spotifyContext, stopSpotify := context.WithCancel(context.Background())
	defer stopSpotify()
	go spotify.run(spotifyContext)
	audio := &audioMonitor{}
	go audio.run(spotifyContext)
	vision := &visionHub{}
	home, _ := os.UserHomeDir()
	motes := newLedger(filepath.Join(home, ".local", "state", "digital-terrarium", "ledger.json"))
	scrub := newScrubber("/proc", os.Getuid(), motes)
	mux.HandleFunc("/api/audio", audio.serve)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"app": "digital-terrarium", "telemetryVersion": 1, "version": bridgeVersion()})
	})
	mux.HandleFunc("/api/ecosystem", collector.serve)
	mux.HandleFunc("/api/agents", agentActivityHandler)
	mux.HandleFunc("/api/stream", streamHandler(collector.current, audio, vision, scrub))
	mux.HandleFunc("/api/orphans", scrub.serveOrphans)
	mux.HandleFunc("/api/scrub", scrub.serveScrub)
	mux.HandleFunc("/api/salvage", scrub.serveSalvage)
	mux.HandleFunc("/api/motes", motes.serve)
	mux.HandleFunc("/api/vision", vision.serve)
	mux.HandleFunc("/api/vision-model", visionModelHandler)
	mux.HandleFunc("/api/spotify/status", spotify.serveStatus)
	mux.HandleFunc("/api/spotify/login", spotify.login)
	mux.HandleFunc("/api/spotify/callback", spotify.callback)
	mux.HandleFunc("/api/wallpaper", wallpaperHandler)
	// Serve only public assets, never repository files or configuration. These
	// are an ES module graph, so they must never be cached: a viewer holding a
	// stale copy of one module against a fresh copy of another fails to link
	// the graph at all, and the scene silently never starts.
	for _, name := range []string{"terrarium.html", "terrarium.mjs", "agent-activity.mjs", "ecology.mjs",
		"vision.html", "vision-source.mjs", "vision.mjs", "vision-topology.mjs", "scrubber.mjs"} {
		mux.HandleFunc("/"+name, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, name)
		})
	}
	// The vision renderer needs the MediaPipe runtime and its wasm over http:
	// getUserMedia requires a secure context, which a file:// page is not. Only
	// this one package directory is exposed, never the wider dependency tree.
	mux.Handle("/vendor/tasks-vision/", http.StripPrefix("/vendor/tasks-vision/",
		http.FileServer(http.Dir("node_modules/@mediapipe/tasks-vision"))))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/terrarium.html", http.StatusTemporaryRedirect)
	})
	address := os.Getenv("TERRARIUM_ADDRESS")
	if address == "" {
		address = "127.0.0.1:8091"
	}
	log.Printf("Digital Terrarium listening on http://%s", address)
	log.Fatal((&http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 2 * time.Second}).ListenAndServe())
}
