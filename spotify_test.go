package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func floatPointer(value float64) *float64 { return &value }

func TestSpotifyMood(t *testing.T) {
	tests := []struct {
		name string
		data Ecosystem
		want string
	}{
		{"idle", Ecosystem{}, "calm"},
		{"working", Ecosystem{CPU: floatPointer(.2)}, "flow"},
		{"download", Ecosystem{Network: []Network{{RX: floatPointer(6 * 1024 * 1024)}}}, "busy"},
		{"loaded", Ecosystem{CPU: floatPointer(.6)}, "busy"},
		{"pressure", Ecosystem{Memory: Memory{Pressure: floatPointer(.06)}}, "chaotic"},
		{"saturated", Ecosystem{CPU: floatPointer(.9)}, "chaotic"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := spotifyMood(test.data); got != test.want {
				t.Fatalf("spotifyMood() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSpotifyConfiguredRequiresEveryMood(t *testing.T) {
	s := spotifyController{config: spotifyConfig{ClientID: "client", Enabled: true, Playlists: map[string][]string{
		"calm": {"a"}, "flow": {"b"}, "busy": {"c"},
	}}}
	if s.configured() {
		t.Fatal("incomplete mood configuration accepted")
	}
	s.config.Playlists["chaotic"] = []string{"d"}
	if !s.configured() {
		t.Fatal("complete mood configuration rejected")
	}
}

func TestSpotifyTickOnlyChangesPlaylistWhenMoodChanges(t *testing.T) {
	played := ""
	playCalls := 0
	track := "old-song"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/me/player":
			_, _ = w.Write([]byte(`{"is_playing":true,"context":{"uri":"spotify:playlist:calm-list"},"item":{"id":"` + track + `"}}`))
		case "/v1/me/player/devices":
			_, _ = w.Write([]byte(`{"devices":[{"id":"local","name":"Workstation"}]}`))
		case "/v1/me/player/play":
			playCalls++
			var body struct {
				ContextURI string `json:"context_uri"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			played = body.ContextURI
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	playlists := map[string][]string{"calm": {"calm-list"}, "flow": {"flow-list"}, "busy": {"busy-list"}, "chaotic": {"chaotic-list"}}
	s := spotifyController{
		config:  spotifyConfig{ClientID: "client", Enabled: true, DeviceName: "Workstation", Playlists: playlists},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL + "/v1", client: server.Client(), mood: "calm", playlistMood: "calm", playlist: "spotify:playlist:calm-list",
		snapshot: func() Ecosystem { return Ecosystem{CPU: floatPointer(.6)} },
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if playCalls != 0 || s.pendingMood != "busy" || s.pendingTrack != "old-song" {
		t.Fatalf("changed before song ended: plays=%d pending=%q track=%q", playCalls, s.pendingMood, s.pendingTrack)
	}
	track = "next-song"
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if played != "spotify:playlist:busy-list" || s.mood != "busy" || s.playlistMood != "busy" {
		t.Fatalf("played=%q mood=%q playlist mood=%q", played, s.mood, s.playlistMood)
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if playCalls != 1 {
		t.Fatal("restarted the playlist while the mood was unchanged")
	}
}

func TestSpotifyTickDoesNotRestartSharedPlaylist(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path == "/v1/me/player" {
			_, _ = w.Write([]byte(`{"is_playing":true,"item":{"id":"song"}}`))
			return
		}
		t.Fatalf("unexpected request: %s", r.URL)
	}))
	defer server.Close()
	playlists := map[string][]string{"calm": {"same"}, "flow": {"same"}, "busy": {"busy"}, "chaotic": {"chaotic"}}
	s := spotifyController{
		config:  spotifyConfig{ClientID: "client", Enabled: true, Playlists: playlists},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL + "/v1", client: server.Client(), playlistMood: "calm", playlist: "spotify:playlist:same",
		snapshot: func() Ecosystem { return Ecosystem{CPU: floatPointer(.2)} },
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests != 1 || s.playlistMood != "flow" {
		t.Fatalf("requests=%d playlist mood=%q", requests, s.playlistMood)
	}
}

func TestSpotifyTickWaitsForCurrentSongAndPlaybackBeforeChangingPlaylist(t *testing.T) {
	playing := false
	track := "current"
	plays := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/me/player":
			_, _ = w.Write([]byte(`{"is_playing":` + map[bool]string{true: "true", false: "false"}[playing] + `,"item":{"id":"` + track + `"}}`))
		case "/v1/me/player/devices":
			_, _ = w.Write([]byte(`{"devices":[{"id":"local","name":"Workstation"}]}`))
		case "/v1/me/player/play":
			plays++
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Fatalf("unexpected request: %s", r.URL)
		}
	}))
	defer server.Close()
	playlists := map[string][]string{"calm": {"calm"}, "flow": {"flow"}, "busy": {"busy"}, "chaotic": {"chaotic"}}
	s := spotifyController{
		config:  spotifyConfig{ClientID: "client", Enabled: true, DeviceName: "Workstation", Playlists: playlists},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL + "/v1", client: server.Client(), playlistMood: "calm", playlist: "spotify:playlist:calm",
		snapshot: func() Ecosystem { return Ecosystem{CPU: floatPointer(.6)} },
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if plays != 0 || s.playlistMood != "calm" {
		t.Fatal("a deliberate pause should leave the mood change pending")
	}
	playing = true
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if plays != 0 || s.playlistMood != "calm" {
		t.Fatal("resuming the same song should not cut it off")
	}
	track = "next"
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if plays != 1 || s.playlistMood != "busy" {
		t.Fatal("the pending mood change was not applied after playback resumed")
	}
}

func TestSpotifyTickCancelsStaleVibeShift(t *testing.T) {
	mood := "busy"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{"is_playing":true,"item":{"id":"current"}}`))
	}))
	defer server.Close()
	playlists := map[string][]string{"calm": {"calm"}, "flow": {"flow"}, "busy": {"busy"}, "chaotic": {"chaotic"}}
	s := spotifyController{
		config:  spotifyConfig{ClientID: "client", Enabled: true, Playlists: playlists},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL, client: server.Client(), playlistMood: "calm", playlist: "spotify:playlist:calm",
		snapshot: func() Ecosystem {
			if mood == "busy" {
				return Ecosystem{CPU: floatPointer(.6)}
			}
			return Ecosystem{}
		},
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.pendingMood != "busy" {
		t.Fatal("vibe shift was not made pending")
	}
	mood = "calm"
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.pendingMood != "" || requests != 1 {
		t.Fatalf("stale shift was not cancelled without another API call: pending=%q requests=%d", s.pendingMood, requests)
	}
}

func TestSpotifyStartupUsesMoodOnceAndRespectsPause(t *testing.T) {
	plays := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/me/player/devices":
			_, _ = w.Write([]byte(`{"devices":[{"id":"phone","name":"Phone"},{"id":"local","name":"Workstation"}]}`))
		case "/v1/me/player/play":
			plays++
			var body struct {
				ContextURI string `json:"context_uri"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if r.Method != http.MethodPut || r.URL.Query().Get("device_id") != "local" || r.Header.Get("Content-Type") != "application/json" || body.ContextURI != "spotify:playlist:busy-list" {
				t.Errorf("unexpected playback request: %s %s %+v", r.Method, r.URL, body)
			}
			w.WriteHeader(http.StatusNoContent)
		case "/v1/me/player":
			_, _ = w.Write([]byte(`{"is_playing":false,"progress_ms":0,"item":{"id":"chosen","duration_ms":120000}}`))
		default:
			t.Errorf("unexpected request: %s", r.URL)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	s := spotifyController{
		config:  spotifyConfig{ClientID: "client", Enabled: true, DeviceName: "Workstation", Playlists: map[string][]string{"calm": {"calm-list"}, "flow": {"flow-list"}, "busy": {"busy-list"}, "chaotic": {"chaotic-list"}}},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL + "/v1", client: server.Client(), startPending: true,
		snapshot: func() Ecosystem { return Ecosystem{CPU: floatPointer(.6)} },
	}
	for range 2 {
		if err := s.tick(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if plays != 1 || s.status().StartPending || s.status().LastStarted != "spotify:playlist:busy-list" {
		t.Fatalf("plays=%d status=%+v", plays, s.status())
	}
}

func TestSpotifyStartupDoesNotUseAnotherDevice(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/me/player/devices" {
			t.Errorf("unexpected request: %s", r.URL)
		}
		_, _ = w.Write([]byte(`{"devices":[{"id":"phone","name":"Phone"}]}`))
	}))
	defer server.Close()
	s := spotifyController{
		config:  spotifyConfig{DeviceName: "Workstation"},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL + "/v1", client: server.Client(), startPending: true,
	}
	if err := s.startFromMood(context.Background(), "calm"); err == nil {
		t.Fatal("accepted wrong device")
	}
	if !s.startPending {
		t.Fatal("startup should remain pending")
	}
}

func TestStartupPlaybackRunsOncePerSession(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	t.Setenv("TERRARIUM_SPOTIFY_START_ON_LAUNCH", "true")
	t.Setenv("TERRARIUM_SPOTIFY_CONFIG", filepath.Join(t.TempDir(), "spotify.json"))
	if !newSpotifyController(func() Ecosystem { return Ecosystem{} }).startPending {
		t.Fatal("first launch of a session must schedule startup playback")
	}
	markStartupPlaybackDone()
	if newSpotifyController(func() Ecosystem { return Ecosystem{} }).startPending {
		t.Fatal("a restart within the same session must not replay startup playback")
	}
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	if !newSpotifyController(func() Ecosystem { return Ecosystem{} }).startPending {
		t.Fatal("a new session must play again")
	}
}
