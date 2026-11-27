package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web/*
var assets embed.FS

type title struct {
	ID               int      `json:"id"`
	Kind             string   `json:"media_type"`
	Name             string   `json:"title"`
	OriginalName     string   `json:"original_title"`
	Date             string   `json:"release_date"`
	Status           string   `json:"status"`
	OriginalLanguage string   `json:"original_language"`
	PosterPath       string   `json:"poster_path"`
	IMDbID           string   `json:"imdb_id,omitempty"`
	TVDBID           *int     `json:"tvdb_id,omitempty"`
	OriginCountries  []string `json:"origin_country"`
}

func validKind(kind string) bool {
	return kind == "movie" || kind == "tv"
}

type library struct {
	mu     sync.Mutex
	path   string
	titles []storedTitle
}

type storedTitle struct {
	title
	// Preserve titles set aside by older versions.
	Archived bool `json:"trashed,omitempty"`
}

func openLibrary(path string) (*library, error) {
	list := &library{path: path}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return list, os.MkdirAll(filepath.Dir(path), 0700)
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &list.titles); err != nil {
		return nil, err
	}
	return list, nil
}

func (list *library) snapshot() []title {
	list.mu.Lock()
	defer list.mu.Unlock()
	items := []title{}
	for _, item := range list.titles {
		if !item.Archived {
			items = append(items, item.title)
		}
	}
	return items
}

func (list *library) find(kind string, id int) (storedTitle, bool) {
	list.mu.Lock()
	defer list.mu.Unlock()
	for _, item := range list.titles {
		if item.Kind == kind && item.ID == id {
			return item, true
		}
	}
	return storedTitle{}, false
}

func (item title) hasMetadata() bool {
	return item.OriginCountries != nil && (item.Kind != "tv" || item.TVDBID != nil)
}

func (list *library) fillMetadata(details title) (title, bool, error) {
	list.mu.Lock()
	defer list.mu.Unlock()
	for index, item := range list.titles {
		if item.Kind != details.Kind || item.ID != details.ID {
			continue
		}
		if item.hasMetadata() {
			return item.title, true, nil
		}
		if item.OriginCountries == nil {
			item.OriginCountries = details.OriginCountries
		}
		if item.TVDBID == nil {
			item.TVDBID = details.TVDBID
		}
		if item.IMDbID == "" {
			item.IMDbID = details.IMDbID
		}
		if item.Date == "" {
			item.Date = details.Date
		}
		next := slices.Clone(list.titles)
		next[index] = item
		return item.title, true, list.save(next)
	}
	return title{}, false, nil
}

func (list *library) add(item title) (title, bool, error) {
	list.mu.Lock()
	defer list.mu.Unlock()
	for index, current := range list.titles {
		if item.Kind == current.Kind && item.ID == current.ID {
			if !current.Archived {
				return current.title, false, nil
			}
			restored := append([]storedTitle{{title: current.title}}, list.titles[:index]...)
			restored = append(restored, list.titles[index+1:]...)
			return current.title, true, list.save(restored)
		}
	}
	next := append([]storedTitle{{title: item}}, list.titles...)
	return item, true, list.save(next)
}

func (list *library) remove(kind string, id int) error {
	list.mu.Lock()
	defer list.mu.Unlock()
	for index, item := range list.titles {
		if item.Kind == kind && item.ID == id && !item.Archived {
			return list.save(slices.Delete(slices.Clone(list.titles), index, index+1))
		}
	}
	return nil
}

func (list *library) save(next []storedTitle) error {
	if err := saveJSON(list.path, next); err != nil {
		return err
	}
	list.titles = next
	return nil
}

func saveJSON(path string, value any) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".listarr-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := json.NewEncoder(file).Encode(value); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

type app struct {
	library  *library
	tmdb     tmdb
	region   string
	prowlarr *prowlarr
	wikidata *http.Client
}

func (a app) handler() http.Handler {
	web, _ := fs.Sub(assets, "web")
	mux := http.NewServeMux()
	files := http.FileServer(http.FS(web))
	mux.Handle("GET /", files)
	mux.HandleFunc("GET /title/{kind}/{id}", func(w http.ResponseWriter, r *http.Request) {
		page := r.Clone(r.Context())
		page.URL.Path = "/"
		files.ServeHTTP(w, page)
	})
	mux.HandleFunc("GET /api/wishlist", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.library.snapshot())
	})
	mux.HandleFunc("GET /api/search", a.search)
	mux.HandleFunc("GET /api/wishlist/movie/{id}/availability", a.movieAvailability)
	mux.HandleFunc("GET /api/wishlist/{kind}/{id}/metadata", a.titleMetadata)
	mux.HandleFunc("GET /api/wishlist/{kind}/{id}/details", a.titlePage)
	mux.HandleFunc("GET /api/wishlist/{kind}/{id}/filmaffinity", a.titleFilmAffinity)
	mux.HandleFunc("POST /api/wishlist", a.add)
	mux.HandleFunc("DELETE /api/wishlist/{kind}/{id}", a.deleteTitle)
	if a.prowlarr != nil {
		a.prowlarr.routes(mux)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://image.tmdb.org; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}

func (a app) savedTitle(w http.ResponseWriter, r *http.Request) (storedTitle, bool) {
	kind := r.PathValue("kind")
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id < 1 || id > maxTMDBID || !validKind(kind) {
		writeError(w, http.StatusBadRequest, "Select a valid title.")
		return storedTitle{}, false
	}
	item, found := a.library.find(kind, id)
	if !found || item.Archived {
		writeError(w, http.StatusNotFound, "This title is no longer in the library.")
		return storedTitle{}, false
	}
	return item, true
}

func (a app) titlePage(w http.ResponseWriter, r *http.Request) {
	item, ok := a.savedTitle(w, r)
	if !ok {
		return
	}
	details, err := a.tmdb.fullDetails(r.Context(), item.title)
	if err != nil {
		writeTMDBError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, details)
}

func (a app) titleFilmAffinity(w http.ResponseWriter, r *http.Request) {
	item, ok := a.savedTitle(w, r)
	if !ok {
		return
	}
	if !imdbPattern.MatchString(item.IMDbID) {
		if details, err := a.tmdb.details(r.Context(), item.Kind, item.ID); err == nil {
			item.IMDbID = details.IMDbID
		}
	}
	id, err := lookupFilmAffinity(r.Context(), a.wikidata, item.title)
	if err != nil {
		writeError(w, http.StatusBadGateway, "FilmAffinity lookup is temporarily unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (a app) titleMetadata(w http.ResponseWriter, r *http.Request) {
	item, ok := a.savedTitle(w, r)
	if !ok {
		return
	}
	if item.hasMetadata() {
		writeJSON(w, http.StatusOK, item.title)
		return
	}
	details, err := a.tmdb.details(r.Context(), item.Kind, item.ID)
	if err != nil {
		writeTMDBError(w, err)
		return
	}
	updated, found, err := a.library.fillMetadata(details)
	if err != nil {
		log.Printf("save title metadata: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save title metadata.")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "This title is no longer in the library.")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a app) movieAvailability(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id < 1 || id > maxTMDBID {
		writeError(w, http.StatusBadRequest, "Select a valid film.")
		return
	}
	if item, found := a.library.find("movie", id); !found || item.Archived {
		writeError(w, http.StatusNotFound, "This film is no longer in the library.")
		return
	}
	availability, err := a.tmdb.availability(r.Context(), id, a.region)
	if err != nil {
		writeTMDBError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	writeJSON(w, http.StatusOK, availability)
}

func (a app) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || len(query) > 256 {
		writeError(w, http.StatusBadRequest, "Enter a title or ID (up to 256 bytes).")
		return
	}

	page := 1
	if rawPage := r.URL.Query().Get("page"); rawPage != "" {
		var err error
		page, err = strconv.Atoi(rawPage)
		if err != nil || page < 1 || page > 500 {
			writeError(w, http.StatusBadRequest, "This search page is unavailable.")
			return
		}
	}

	result, err := a.tmdb.search(r.Context(), query, page)
	if err != nil {
		writeTMDBError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a app) add(w http.ResponseWriter, r *http.Request) {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "Expected a JSON title selection.")
		return
	}

	var selection struct {
		ID   int    `json:"id"`
		Kind string `json:"media_type"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	if err := decoder.Decode(&selection); err != nil || selection.ID < 1 || selection.ID > maxTMDBID || !validKind(selection.Kind) {
		writeError(w, http.StatusBadRequest, "Select a film or TV show with a valid TMDB ID.")
		return
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "Expected one title selection.")
		return
	}

	current, found := a.library.find(selection.Kind, selection.ID)
	item := current.title
	if found {
		if !current.Archived {
			writeJSON(w, http.StatusOK, item)
			return
		}
	} else {
		var err error
		item, err = a.tmdb.details(r.Context(), selection.Kind, selection.ID)
		if err != nil {
			writeTMDBError(w, err)
			return
		}
	}
	item, added, err := a.library.add(item)
	if err != nil {
		log.Printf("save wishlist: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save the wishlist.")
		return
	}
	status := http.StatusOK
	if added {
		status = http.StatusCreated
	}
	writeJSON(w, status, item)
}

func (a app) deleteTitle(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id < 1 || id > maxTMDBID || !validKind(kind) {
		writeError(w, http.StatusBadRequest, "Select a valid film or TV show.")
		return
	}
	if err := a.library.remove(kind, id); err != nil {
		log.Printf("save wishlist: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save the wishlist.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	region := strings.ToUpper(strings.TrimSpace(env("TMDB_REGION", "AR")))
	if len(region) != 2 || region[0] < 'A' || region[0] > 'Z' || region[1] < 'A' || region[1] > 'Z' {
		log.Fatal("TMDB_REGION must be a two-letter country code.")
	}
	dataDir := env("DATA_DIR", "data")
	list, err := openLibrary(filepath.Join(dataDir, "wishlist.json"))
	if err != nil {
		log.Fatalf("open wishlist: %v", err)
	}
	prowlarr, err := openProwlarr(filepath.Join(dataDir, "prowlarr.json"))
	if err != nil {
		log.Fatalf("open Prowlarr settings: %v", err)
	}
	a := app{
		library:  list,
		region:   region,
		prowlarr: prowlarr,
		wikidata: &http.Client{Timeout: 5 * time.Second},
		tmdb: tmdb{
			base:   "https://api.themoviedb.org/3",
			apiKey: strings.TrimSpace(os.Getenv("TMDB_API_KEY")),
			client: &http.Client{Timeout: 8 * time.Second},
		},
	}
	server := &http.Server{
		Addr:              env("LISTEN_ADDR", "127.0.0.1:8080"),
		Handler:           http.NewCrossOriginProtection().Handler(a.handler()),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       12 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("listening on %s", server.Addr)
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-done
}
