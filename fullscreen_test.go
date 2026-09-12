package main

import (
	"errors"
	"testing"
)

func TestFullscreenPriority(t *testing.T) {
	for _, tc := range []struct {
		name, root, state  string
		failAt             int
		fullscreen, failed bool
	}{
		{name: "fullscreen", root: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x123", state: "_NET_WM_STATE(ATOM) = _NET_WM_STATE_ABOVE, _NET_WM_STATE_FULLSCREEN", fullscreen: true},
		{name: "ordinary or maximized", root: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x123", state: "_NET_WM_STATE(ATOM) = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_MAXIMIZED_HORZ"},
		{name: "no foreground", root: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0"},
		{name: "missing property", root: "_NET_ACTIVE_WINDOW: not found", failed: true},
		{name: "display unavailable", failAt: 1, failed: true},
		{name: "window closed during query", root: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x123", failAt: 2, failed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			got := detectFullscreen(func(args ...string) (string, error) {
				calls++
				if calls == tc.failAt {
					return "", errors.New("unavailable")
				}
				if calls == 1 {
					return tc.root, nil
				}
				if len(args) != 3 || args[0] != "-id" || args[1] != "0x123" || args[2] != "_NET_WM_STATE" {
					t.Fatalf("unexpected window query: %v", args)
				}
				return tc.state, nil
			})
			if got.Fullscreen != tc.fullscreen || (got.Error != "") != tc.failed {
				t.Fatalf("unexpected state: %+v", got)
			}
		})
	}
}
