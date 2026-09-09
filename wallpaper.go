package main

import (
	"bufio"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func wallpaperHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	configPath := filepath.Join(os.Getenv("HOME"), ".config", "plasma-org.kde.plasma.desktop-appletsrc")
	file, err := os.Open(configPath)
	if err != nil {
		http.Error(w, "wallpaper configuration unavailable", http.StatusNotFound)
		return
	}
	defer file.Close()
	imagePath := ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "Image=") {
			imagePath = strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "Image="))
			break
		}
	}
	if imagePath == "" {
		http.Error(w, "wallpaper image unavailable", http.StatusNotFound)
		return
	}
	if _, err := os.Stat(imagePath); err != nil {
		http.Error(w, "wallpaper image unavailable", http.StatusNotFound)
		return
	}
	http.ServeFile(w, r, imagePath)
}
