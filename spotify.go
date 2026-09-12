package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const spotifyRedirectURI = "http://127.0.0.1:8091/api/spotify/callback"

type spotifyConfig struct {
	ClientID   string              `json:"clientId"`
	Enabled    bool                `json:"enabled"`
	DeviceName string              `json:"deviceName,omitempty"`
	Playlists  map[string][]string `json:"playlists"`
}

type spotifyToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"`
}

type spotifyStatus struct {
	Configured   bool   `json:"configured"`
	Connected    bool   `json:"connected"`
	Enabled      bool   `json:"enabled"`
	Mood         string `json:"mood"`
	LastQueued   string `json:"lastQueued,omitempty"`
	LastError    string `json:"lastError,omitempty"`
	StartPending bool   `json:"startPending"`
	LastStarted  string `json:"lastStarted,omitempty"`
}

type spotifyController struct {
	mu           sync.RWMutex
	config       spotifyConfig
	token        spotifyToken
	tokenPath    string
	apiBase      string
	client       *http.Client
	snapshot     func() Ecosystem
	state        string
	verifier     string
	mood         string
	lastQueued   string
	lastError    string
	queuedForID  string
	startPending bool
	lastStarted  string
}

func loadSpotifyConfig() (spotifyConfig, string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return spotifyConfig{}, "", err
	}
	dir := filepath.Join(root, "digital-terrarium")
	path := os.Getenv("TERRARIUM_SPOTIFY_CONFIG")
	if path == "" {
		path = filepath.Join(dir, "spotify.json")
	} else {
		dir = filepath.Dir(path)
	}
	config := spotifyConfig{Playlists: map[string][]string{}}
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return config, filepath.Join(dir, "spotify-token.json"), err
	}
	if err == nil && json.Unmarshal(b, &config) != nil {
		return config, filepath.Join(dir, "spotify-token.json"), fmt.Errorf("invalid Spotify config %s", path)
	}
	if value := os.Getenv("TERRARIUM_SPOTIFY_CLIENT_ID"); value != "" {
		config.ClientID = value
	}
	if value := os.Getenv("TERRARIUM_SPOTIFY_ENABLED"); value != "" {
		config.Enabled = value == "1" || strings.EqualFold(value, "true")
	}
	for _, mood := range []string{"calm", "flow", "busy", "chaotic"} {
		if value := os.Getenv("TERRARIUM_SPOTIFY_" + strings.ToUpper(mood)); value != "" {
			config.Playlists[mood] = strings.Split(value, ",")
		}
	}
	return config, filepath.Join(dir, "spotify-token.json"), nil
}

// Startup playback belongs to the login session, not to the process. The bridge
// restarts on failure, and without this a crash loop would restart the music
// every time; the marker lives in the runtime directory, which the session
// clears on logout, so the next login plays again.
func startupPlaybackMarker() string {
	runtime := os.Getenv("XDG_RUNTIME_DIR")
	if runtime == "" {
		return ""
	}
	return filepath.Join(runtime, "digital-terrarium", "startup-playback")
}

func startupPlaybackDone() bool {
	marker := startupPlaybackMarker()
	if marker == "" {
		return false
	}
	_, err := os.Stat(marker)
	return err == nil
}

func markStartupPlaybackDone() {
	marker := startupPlaybackMarker()
	if marker == "" {
		return
	}
	if os.MkdirAll(filepath.Dir(marker), 0700) == nil {
		_ = os.WriteFile(marker, nil, 0600)
	}
}

func newSpotifyController(snapshot func() Ecosystem) *spotifyController {
	config, tokenPath, err := loadSpotifyConfig()
	s := &spotifyController{config: config, tokenPath: tokenPath, apiBase: "https://api.spotify.com/v1", client: &http.Client{Timeout: 8 * time.Second}, snapshot: snapshot, mood: "calm"}
	s.startPending = os.Getenv("TERRARIUM_SPOTIFY_START_ON_LAUNCH") == "true" && !startupPlaybackDone()
	if err != nil {
		s.lastError = err.Error()
		return s
	}
	if b, err := os.ReadFile(tokenPath); err == nil {
		_ = json.Unmarshal(b, &s.token)
	}
	return s
}

func (s *spotifyController) configured() bool {
	if s.config.ClientID == "" || !s.config.Enabled {
		return false
	}
	for _, mood := range []string{"calm", "flow", "busy", "chaotic"} {
		if len(s.config.Playlists[mood]) == 0 {
			return false
		}
	}
	return true
}

func (s *spotifyController) status() spotifyStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return spotifyStatus{Configured: s.configured(), Connected: s.token.RefreshToken != "", Enabled: s.config.Enabled, Mood: s.mood, LastQueued: s.lastQueued, LastError: s.lastError, StartPending: s.startPending, LastStarted: s.lastStarted}
}

func (s *spotifyController) serveStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, s.status())
}

func randomURLString(bytes int) (string, error) {
	b := make([]byte, bytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (s *spotifyController) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.config.ClientID == "" {
		http.Error(w, "Set clientId in ~/.config/digital-terrarium/spotify.json first", http.StatusPreconditionFailed)
		return
	}
	state, err := randomURLString(24)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	verifier, err := randomURLString(64)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	challenge := sha256.Sum256([]byte(verifier))
	s.mu.Lock()
	s.state, s.verifier = state, verifier
	s.mu.Unlock()
	query := url.Values{
		"client_id":             {s.config.ClientID},
		"response_type":         {"code"},
		"redirect_uri":          {spotifyRedirectURI},
		"state":                 {state},
		"scope":                 {"user-read-playback-state user-modify-playback-state playlist-read-private"},
		"code_challenge_method": {"S256"},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
	}
	http.Redirect(w, r, "https://accounts.spotify.com/authorize?"+query.Encode(), http.StatusFound)
}

func (s *spotifyController) callback(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	state, verifier := s.state, s.verifier
	s.mu.RUnlock()
	if state == "" || r.URL.Query().Get("state") != state {
		http.Error(w, "Spotify authorization state mismatch", http.StatusBadRequest)
		return
	}
	if message := r.URL.Query().Get("error"); message != "" {
		http.Error(w, "Spotify authorization: "+message, http.StatusBadRequest)
		return
	}
	values := url.Values{"client_id": {s.config.ClientID}, "grant_type": {"authorization_code"}, "code": {r.URL.Query().Get("code")}, "redirect_uri": {spotifyRedirectURI}, "code_verifier": {verifier}}
	var reply struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := s.requestToken(r.Context(), values, &reply); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	s.mu.Lock()
	s.token = spotifyToken{AccessToken: reply.AccessToken, RefreshToken: reply.RefreshToken, ExpiresAt: time.Now().Unix() + reply.ExpiresIn}
	s.state, s.verifier, s.lastError = "", "", ""
	err := s.saveTokenLocked()
	s.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, "<!doctype html><title>Digital Terrarium</title><p>Spotify is connected. You may close this tab.</p>")
}

func (s *spotifyController) requestToken(ctx context.Context, values url.Values, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://accounts.spotify.com/api/token", strings.NewReader(values.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("Spotify token API: %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(response.Body).Decode(target)
}

func (s *spotifyController) saveTokenLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.tokenPath), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(s.token)
	if err != nil {
		return err
	}
	return os.WriteFile(s.tokenPath, b, 0600)
}

func (s *spotifyController) accessToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token.AccessToken != "" && time.Now().Unix() < s.token.ExpiresAt-60 {
		return s.token.AccessToken, nil
	}
	if s.token.RefreshToken == "" {
		return "", errors.New("Spotify is not connected")
	}
	var reply struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	values := url.Values{"client_id": {s.config.ClientID}, "grant_type": {"refresh_token"}, "refresh_token": {s.token.RefreshToken}}
	if err := s.requestToken(ctx, values, &reply); err != nil {
		return "", err
	}
	s.token.AccessToken = reply.AccessToken
	if reply.RefreshToken != "" {
		s.token.RefreshToken = reply.RefreshToken
	}
	s.token.ExpiresAt = time.Now().Unix() + reply.ExpiresIn
	return s.token.AccessToken, s.saveTokenLocked()
}

func spotifyMood(e Ecosystem) string {
	cpu := 0.0
	if e.CPU != nil {
		cpu = *e.CPU
	}
	pressure := 0.0
	if e.Memory.Pressure != nil {
		pressure = *e.Memory.Pressure
	}
	network := 0.0
	for _, item := range e.Network {
		if item.RX != nil {
			network += *item.RX
		}
		if item.TX != nil {
			network += *item.TX
		}
	}
	if pressure >= .05 || cpu >= .8 {
		return "chaotic"
	}
	if cpu >= .45 || network >= 5*1024*1024 {
		return "busy"
	}
	if cpu >= .12 || network >= 256*1024 {
		return "flow"
	}
	return "calm"
}

func (s *spotifyController) api(ctx context.Context, method, path string, body io.Reader, target any) error {
	token, err := s.accessToken(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, s.apiBase+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("Spotify API: %s: %s", response.Status, strings.TrimSpace(string(payload)))
	}
	if target != nil && response.StatusCode != http.StatusNoContent {
		return json.NewDecoder(response.Body).Decode(target)
	}
	return nil
}

func (s *spotifyController) chooseTrack(ctx context.Context, mood string) (string, string, error) {
	playlists := s.config.Playlists[mood]
	if len(playlists) == 0 {
		return "", "", fmt.Errorf("no %s playlists configured", mood)
	}
	playlist := strings.TrimSpace(playlists[time.Now().UnixNano()%int64(len(playlists))])
	playlist = strings.TrimPrefix(playlist, "spotify:playlist:")
	var result struct {
		Items []struct {
			Item struct {
				URI     string `json:"uri"`
				Name    string `json:"name"`
				Artists []struct {
					Name string `json:"name"`
				} `json:"artists"`
			} `json:"item"`
			Track struct {
				URI     string `json:"uri"`
				Name    string `json:"name"`
				Artists []struct {
					Name string `json:"name"`
				} `json:"artists"`
			} `json:"track"`
		} `json:"items"`
	}
	path := "/playlists/" + url.PathEscape(playlist) + "/items?limit=50"
	if err := s.api(ctx, http.MethodGet, path, nil, &result); err != nil {
		return "", "", err
	}
	if len(result.Items) == 0 {
		return "", "", errors.New("Spotify playlist has no playable items")
	}
	start := int(time.Now().UnixNano() % int64(len(result.Items)))
	for offset := range result.Items {
		entry := result.Items[(start+offset)%len(result.Items)]
		track := entry.Item
		if track.URI == "" {
			track = entry.Track
		}
		if strings.HasPrefix(track.URI, "spotify:track:") {
			artist := ""
			if len(track.Artists) > 0 {
				artist = track.Artists[0].Name + " — "
			}
			return track.URI, artist + track.Name, nil
		}
	}
	return "", "", errors.New("Spotify playlist has no playable tracks")
}

// startFromMood runs once per opted-in bridge launch, then normal queueing takes over.
func (s *spotifyController) startFromMood(ctx context.Context, mood string) error {
	name := s.config.DeviceName
	if name == "" {
		name, _ = os.Hostname()
	}
	var reply struct {
		Devices []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			Restricted bool   `json:"is_restricted"`
		} `json:"devices"`
	}
	if err := s.api(ctx, http.MethodGet, "/me/player/devices", nil, &reply); err != nil {
		return err
	}
	deviceID := ""
	for _, device := range reply.Devices {
		if device.Name == name && !device.Restricted && device.ID != "" {
			if deviceID != "" {
				return fmt.Errorf("multiple Spotify devices named %q", name)
			}
			deviceID = device.ID
		}
	}
	if deviceID == "" {
		return fmt.Errorf("waiting for Spotify device %q; open Spotify or set deviceName in spotify.json", name)
	}
	uri, track, err := s.chooseTrack(ctx, mood)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"uris": []string{uri}, "position_ms": 0})
	if err != nil {
		return err
	}
	if err := s.api(ctx, http.MethodPut, "/me/player/play?device_id="+url.QueryEscape(deviceID), strings.NewReader(string(body)), nil); err != nil {
		return err
	}
	s.mu.Lock()
	s.startPending, s.lastStarted, s.lastError = false, track, ""
	s.mu.Unlock()
	markStartupPlaybackDone()
	log.Printf("Spotify started %q for %s mood", track, mood)
	return nil
}

func (s *spotifyController) tick(ctx context.Context) error {
	status := s.status()
	if !status.Configured || !status.Connected {
		return nil
	}
	mood := spotifyMood(s.snapshot())
	s.mu.Lock()
	s.mood = mood
	s.mu.Unlock()
	if status.StartPending {
		return s.startFromMood(ctx, mood)
	}
	var playback struct {
		IsPlaying  bool  `json:"is_playing"`
		ProgressMS int64 `json:"progress_ms"`
		Item       struct {
			ID         string `json:"id"`
			DurationMS int64  `json:"duration_ms"`
		} `json:"item"`
	}
	if err := s.api(ctx, http.MethodGet, "/me/player", nil, &playback); err != nil {
		return err
	}
	if playback.Item.ID != s.queuedForID && (!playback.IsPlaying || playback.Item.DurationMS-playback.ProgressMS > 30_000) {
		s.queuedForID = ""
		return nil
	}
	if playback.Item.ID == "" || playback.Item.ID == s.queuedForID || playback.Item.DurationMS-playback.ProgressMS > 30_000 {
		return nil
	}
	uri, name, err := s.chooseTrack(ctx, mood)
	if err != nil {
		return err
	}
	if err := s.api(ctx, http.MethodPost, "/me/player/queue?uri="+url.QueryEscape(uri), nil, nil); err != nil {
		return err
	}
	s.mu.Lock()
	s.queuedForID, s.lastQueued, s.lastError = playback.Item.ID, name, ""
	s.mu.Unlock()
	log.Printf("Spotify queued %q for %s mood", name, mood)
	return nil
}

func (s *spotifyController) run(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.tick(ctx); err != nil {
				s.mu.Lock()
				s.lastError = err.Error()
				s.mu.Unlock()
			}
		}
	}
}
