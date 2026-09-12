package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type fullscreenState struct {
	Fullscreen bool   `json:"fullscreen"`
	Window     string `json:"window,omitempty"`
	Error      string `json:"error,omitempty"`
}

var windowIDPattern = regexp.MustCompile(`(?i)window id # (0x[0-9a-f]+)`)

// Query the foreground window, not every fullscreen window: an application
// on another workspace or behind the foreground app must not suppress us.
func detectFullscreen(query func(...string) (string, error)) fullscreenState {
	root, err := query("-root", "_NET_ACTIVE_WINDOW")
	if err != nil {
		return fullscreenState{Error: err.Error()}
	}
	match := windowIDPattern.FindStringSubmatch(root)
	if len(match) != 2 {
		return fullscreenState{Error: "active window property unavailable"}
	}
	id := match[1]
	if strings.TrimLeft(strings.ToLower(id[2:]), "0") == "" {
		return fullscreenState{}
	}
	state, err := query("-id", id, "_NET_WM_STATE")
	if err != nil {
		return fullscreenState{Error: err.Error()}
	}
	for _, atom := range strings.FieldsFunc(state, func(r rune) bool {
		return r == '=' || r == ',' || r == ' ' || r == '\n' || r == '\t'
	}) {
		if atom == "_NET_WM_STATE_FULLSCREEN" {
			return fullscreenState{Fullscreen: true, Window: id}
		}
	}
	return fullscreenState{Window: id}
}

func desktopFullscreenState() fullscreenState {
	if os.Getenv("XDG_SESSION_TYPE") == "wayland" {
		return fullscreenState{Error: "native Wayland fullscreen detection is not supported"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return detectFullscreen(func(args ...string) (string, error) {
		output, err := exec.CommandContext(ctx, "xprop", args...).Output()
		if err != nil {
			return "", fmt.Errorf("X11 fullscreen detection unavailable: %w", err)
		}
		return string(output), nil
	})
}
