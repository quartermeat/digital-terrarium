package main

import (
	"math/rand"
	"net/http"
)

// A fixed seed makes initial populations reproducible across renderers.
func habitatHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rng := rand.New(rand.NewSource(1))
	creatures := make([]map[string]float64, 28)
	for i := range creatures {
		creatures[i] = map[string]float64{"x": rng.Float64(), "y": rng.Float64(), "phase": float64(i) * 2.4, "energy": .5, "speed": .025 + rng.Float64()*.025}
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "seed": 1, "creatures": creatures})
}
