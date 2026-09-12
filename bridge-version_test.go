package main

import "testing"

func TestBridgeVersion(t *testing.T) {
	if bridgeVersion() == "" {
		t.Fatal("embedded build version is empty")
	}
}
