package main

import (
	"encoding/json"
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
func main() {
	collector := newCollector("/proc", os.Getuid())
	collector.update(time.Now())
	go func() {
		for now := range time.NewTicker(time.Second).C {
			collector.update(now)
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"app": "digital-terrarium", "telemetryVersion": 1})
	})
	mux.HandleFunc("/api/ecosystem", collector.serve)
	mux.HandleFunc("/api/wallpaper", wallpaperHandler)
	// Serve only public assets, never repository files or configuration.
	for _, name := range []string{"terrarium.html", "terrarium.mjs", "ecology.mjs", "creature-compute.mjs", "creature-compute-gl.mjs", "creature-compute.vert", "creature-compute.wgsl"} {
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
