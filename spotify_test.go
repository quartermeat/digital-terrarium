package main

import (
	"context"
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
