package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
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
func streamHandler(snapshot func() Ecosystem, audio *audioMonitor) http.HandlerFunc {
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
		if !send("ecosystem", snapshot()) || !send("agents", agentActivityPayload()) || !send("audio", audio.frameNow()) {
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
			}
		}
	}
}

func main() {
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
	mux.HandleFunc("/api/audio", audio.serve)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"app": "digital-terrarium", "telemetryVersion": 1})
	})
	mux.HandleFunc("/api/ecosystem", collector.serve)
	mux.HandleFunc("/api/agents", agentActivityHandler)
	mux.HandleFunc("/api/stream", streamHandler(collector.current, audio))
	mux.HandleFunc("/api/spotify/status", spotify.serveStatus)
	mux.HandleFunc("/api/spotify/login", spotify.login)
	mux.HandleFunc("/api/spotify/callback", spotify.callback)
	mux.HandleFunc("/api/wallpaper", wallpaperHandler)
	// Serve only public assets, never repository files or configuration.
	for _, name := range []string{"terrarium.html", "terrarium.mjs", "agent-activity.mjs", "ecology.mjs"} {
		mux.HandleFunc("/"+name, func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, name) })
	}
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
