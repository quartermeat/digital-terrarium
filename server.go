package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const (
	address = "127.0.0.1:8090"
	origin  = "http://127.0.0.1:8090"
)

var volumeSteps = map[string]string{"up": "5%+", "down": "5%-"}
var mediaActions = map[string]string{"next": "next", "previous": "previous"}

type phoneSignal struct {
	sync.RWMutex
	offer, answer               string
	previewOffer, previewAnswer string
	poolCalibration             string
}

func signalHandler(response http.ResponseWriter, request *http.Request, preview bool) {
	isAnswer := strings.HasSuffix(request.URL.Path, "answer")
	get := func() string {
		phone.RLock()
		defer phone.RUnlock()
		if preview {
			return phone.previewOffer
		}
		return phone.offer
	}
	set := func(value string) {
		phone.Lock()
		defer phone.Unlock()
		if preview {
			phone.previewOffer, phone.previewAnswer = value, ""
		} else {
			phone.offer, phone.answer = value, ""
		}
	}
	getAnswer := func() string {
		phone.RLock()
		defer phone.RUnlock()
		if preview {
			return phone.previewAnswer
		}
		return phone.answer
	}
	setAnswer := func(value string) {
		phone.Lock()
		defer phone.Unlock()
		if preview {
			phone.previewAnswer = value
		} else {
			phone.answer = value
		}
	}
	if request.Method == http.MethodGet {
		value := get()
		if isAnswer {
			value = getAnswer()
		}
		writeJSON(response, http.StatusOK, map[string]string{"sdp": value})
		return
	}
	if request.Method != http.MethodPost || !strings.HasPrefix(request.Header.Get("Content-Type"), "application/json") {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "JSON POST required"})
		return
	}
	var payload struct {
		SDP string `json:"sdp"`
	}
	request.Body = http.MaxBytesReader(response, request.Body, 2<<20)
	if json.NewDecoder(request.Body).Decode(&payload) != nil || payload.SDP == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "SDP required"})
		return
	}
	if isAnswer {
		setAnswer(payload.SDP)
	} else {
		set(payload.SDP)
	}
	writeJSON(response, http.StatusAccepted, map[string]bool{"ok": true})
}

var phone phoneSignal

type commandRequest struct {
	Direction string `json:"direction"`
	Action    string `json:"action"`
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	if err := json.NewEncoder(response).Encode(payload); err != nil {
		log.Printf("write response: %v", err)
	}
}

func validateRequest(response http.ResponseWriter, request *http.Request) bool {
	if request.Method != http.MethodPost {
		writeJSON(response, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return false
	}
	if requestOrigin := request.Header.Get("Origin"); requestOrigin != "" && requestOrigin != origin {
		writeJSON(response, http.StatusForbidden, map[string]string{"error": "Cross-origin request denied"})
		return false
	}
	if !strings.HasPrefix(request.Header.Get("Content-Type"), "application/json") {
		writeJSON(response, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON required"})
		return false
	}
	request.Body = http.MaxBytesReader(response, request.Body, 256)
	return true
}

func volumeHandler(response http.ResponseWriter, request *http.Request) {
	if !validateRequest(response, request) {
		return
	}
	var payload commandRequest
	if json.NewDecoder(request.Body).Decode(&payload) != nil || volumeSteps[payload.Direction] == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "Unsupported audio-control command"})
		return
	}
	if err := exec.Command("wpctl", "set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", volumeSteps[payload.Direction]).Run(); err != nil {
		log.Printf("volume command: %v", err)
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "Audio control unavailable"})
		return
	}
	output, err := exec.Command("wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@").Output()
	if err != nil {
		log.Printf("read volume: %v", err)
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "Audio control unavailable"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"direction": payload.Direction, "volume": strings.TrimSpace(string(output))})
}

func mediaHandler(response http.ResponseWriter, request *http.Request) {
	if !validateRequest(response, request) {
		return
	}
	var payload commandRequest
	if json.NewDecoder(request.Body).Decode(&payload) != nil || mediaActions[payload.Action] == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "Unsupported audio-control command"})
		return
	}
	if err := exec.Command("playerctl", mediaActions[payload.Action]).Run(); err != nil {
		log.Printf("media command: %v", err)
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "Audio control unavailable"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"action": payload.Action})
}

func phoneOfferHandler(response http.ResponseWriter, request *http.Request) {
	signalHandler(response, request, false)
}

func phoneAnswerHandler(response http.ResponseWriter, request *http.Request) {
	signalHandler(response, request, false)
}

func poolCalibrationHandler(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodPost {
		var payload struct {
			Points json.RawMessage `json:"points"`
		}
		if json.NewDecoder(request.Body).Decode(&payload) != nil || len(payload.Points) == 0 {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "Invalid calibration points"})
			return
		}
		phone.Lock()
		phone.poolCalibration = string(payload.Points)
		phone.Unlock()
	}
	phone.RLock()
	points := phone.poolCalibration
	phone.RUnlock()
	if points == "" {
		points = "[]"
	}
	writeJSON(response, http.StatusOK, map[string]string{"points": points})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/habitat", habitatHandler)
	mux.HandleFunc("/api/system-stats", systemStatsHandler)
	mux.HandleFunc("/api/wallpaper", wallpaperHandler)
	mux.HandleFunc("/api/volume", volumeHandler)
	mux.HandleFunc("/api/media", mediaHandler)
	mux.HandleFunc("/api/phone/offer", phoneOfferHandler)
	mux.HandleFunc("/api/phone/answer", phoneAnswerHandler)
	mux.HandleFunc("/api/phone/preview-offer", func(w http.ResponseWriter, r *http.Request) { signalHandler(w, r, true) })
	mux.HandleFunc("/api/phone/preview-answer", func(w http.ResponseWriter, r *http.Request) { signalHandler(w, r, true) })
	mux.HandleFunc("/api/pool/calibration", poolCalibrationHandler)
	mux.Handle("/", http.FileServer(http.Dir(".")))
	bindAddress := os.Getenv("WEBCAM_VIEWER_BIND")
	if bindAddress == "" {
		bindAddress = address
	} else if _, _, err := net.SplitHostPort(bindAddress); err != nil {
		bindAddress = net.JoinHostPort(bindAddress, "8090")
	}
	server := &http.Server{Addr: bindAddress, Handler: mux, ReadHeaderTimeout: 2 * time.Second}
	log.Printf("Serving Human Interface on http://%s/", bindAddress)
	if certFile, keyFile := os.Getenv("WEBCAM_VIEWER_TLS_CERT"), os.Getenv("WEBCAM_VIEWER_TLS_KEY"); certFile != "" && keyFile != "" {
		tlsBind := os.Getenv("WEBCAM_VIEWER_TLS_BIND")
		if tlsBind == "" {
			tlsBind = ":8443"
		} else if _, _, err := net.SplitHostPort(tlsBind); err != nil {
			tlsBind = net.JoinHostPort(tlsBind, "8443")
		}
		tlsServer := &http.Server{Addr: tlsBind, Handler: mux, ReadHeaderTimeout: 2 * time.Second}
		go func() {
			log.Printf("Serving secure phone interface on https://%s/", tlsBind)
			if err := tlsServer.ListenAndServeTLS(certFile, keyFile); err != nil && err != http.ErrServerClosed {
				log.Fatal(err)
			}
		}()
	}
	log.Fatal(server.ListenAndServe())
}
