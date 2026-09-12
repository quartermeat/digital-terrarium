package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestSpotifyTickQueuesFromCurrentMood(t *testing.T) {
	queued := ""
	queueCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v1/me/player":
			_, _ = w.Write([]byte(`{"is_playing":true,"progress_ms":95000,"item":{"id":"playing","duration_ms":120000}}`))
		case r.URL.Path == "/v1/playlists/busy-list/items":
			_, _ = w.Write([]byte(`{"items":[{"item":{"uri":"spotify:track:next","name":"Next Track","artists":[{"name":"Artist"}]}}]}`))
		case r.URL.Path == "/v1/me/player/queue":
			queued = r.URL.Query().Get("uri")
			queueCalls++
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	playlists := map[string][]string{"calm": {"calm-list"}, "flow": {"flow-list"}, "busy": {"busy-list"}, "chaotic": {"chaotic-list"}}
	s := spotifyController{
		config:  spotifyConfig{ClientID: "client", Enabled: true, Playlists: playlists},
		token:   spotifyToken{AccessToken: "token", RefreshToken: "refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		apiBase: server.URL + "/v1", client: server.Client(), mood: "calm",
		snapshot: func() Ecosystem { return Ecosystem{CPU: floatPointer(.6)} },
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queued != "spotify:track:next" || s.mood != "busy" || s.lastQueued != "Artist — Next Track" {
		t.Fatalf("queued=%q mood=%q last=%q", queued, s.mood, s.lastQueued)
	}
	if err := s.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if queueCalls != 1 {
		t.Fatal("queued more than once for the same current track")
	}
}

func TestSpotifyStartupUsesMoodOnceAndRespectsPause(t *testing.T) {
	plays := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/me/player/devices":
			_, _ = w.Write([]byte(`{"devices":[{"id":"phone","name":"Phone"},{"id":"local","name":"Workstation"}]}`))
		case "/v1/playlists/busy-list/items":
			_, _ = w.Write([]byte(`{"items":[{"item":{"uri":"spotify:track:chosen","name":"Chosen","artists":[]}}]}`))
		case "/v1/me/player/play":
			plays++
			var body struct {
				URIs []string `json:"uris"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if r.Method != http.MethodPut || r.URL.Query().Get("device_id") != "local" || r.Header.Get("Content-Type") != "application/json" || len(body.URIs) != 1 || body.URIs[0] != "spotify:track:chosen" {
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
	if plays != 1 || s.status().StartPending || s.status().LastStarted != "Chosen" {
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
