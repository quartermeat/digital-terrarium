package main

import (
	_ "embed"
	"encoding/json"
)

// Embed the manifest so an old executable cannot report a newer on-disk version.
//
//go:embed package.json
var buildManifest []byte

func bridgeVersion() string {
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(buildManifest, &manifest); err != nil {
		panic(err)
	}
	return manifest.Version
}
