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
	ID               int    `json:"id"`
	Kind             string `json:"media_type"`
	Name             string `json:"title"`
	OriginalName     string `json:"original_title"`
	Date             string `json:"release_date"`
	Status           string `json:"status"`
	OriginalLanguage string `json:"original_language"`
	PosterPath       string `json:"poster_path"`
	IMDbID           string `json:"imdb_id,omitempty"`
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
	Trashed bool `json:"trashed,omitempty"`
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
	return list.titlesByTrashStatus(false)
}

func (list *library) titlesByTrashStatus(trashed bool) []title {
	list.mu.Lock()
	defer list.mu.Unlock()
	items := []title{}
	for _, item := range list.titles {
		if item.Trashed == trashed {
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

func (list *library) add(item title) (title, bool, error) {
	list.mu.Lock()
	defer list.mu.Unlock()
	for index, current := range list.titles {
		if item.Kind == current.Kind && item.ID == current.ID {
			if !current.Trashed {
				return current.title, false, nil
			}
			return current.title, true, list.setTrashed(index, false)
		}
	}
	next := append([]storedTitle{{title: item}}, list.titles...)
	return item, true, list.save(next)
}

func (list *library) move(kind string, id int, trashed bool) (title, bool, error) {
	list.mu.Lock()
	defer list.mu.Unlock()
	for index, item := range list.titles {
		if item.Kind == kind && item.ID == id {
			if item.Trashed == trashed {
				return item.title, true, nil
			}
			return item.title, true, list.setTrashed(index, trashed)
		}
	}
	return title{}, false, nil
}

// setTrashed requires the caller to hold list.mu.
func (list *library) setTrashed(index int, trashed bool) error {
	item := list.titles[index]
	item.Trashed = trashed
	next := make([]storedTitle, 0, len(list.titles))
	next = append(next, item)
	next = append(next, list.titles[:index]...)
	next = append(next, list.titles[index+1:]...)
	return list.save(next)
}

func (list *library) emptyTrash() error {
	list.mu.Lock()
	defer list.mu.Unlock()
	next := slices.DeleteFunc(slices.Clone(list.titles), func(item storedTitle) bool {
		return item.Trashed
	})
	if len(next) == len(list.titles) {
		return nil
	}
	return list.save(next)
}

func (list *library) save(next []storedTitle) error {
	file, err := os.CreateTemp(filepath.Dir(list.path), ".wishlist-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := json.NewEncoder(file).Encode(next); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), list.path); err != nil {
		return err
	}
	list.titles = next
	return nil
}

type app struct {
	library *library
	tmdb    tmdb
	region  string
}

func (a app) handler() http.Handler {
	web, _ := fs.Sub(assets, "web")
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServer(http.FS(web)))
	mux.HandleFunc("GET /api/wishlist", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.library.snapshot())
	})
	mux.HandleFunc("GET /api/search", a.search)
	mux.HandleFunc("GET /api/wishlist/movie/{id}/availability", a.movieAvailability)
	mux.HandleFunc("POST /api/wishlist", a.add)
	mux.HandleFunc("DELETE /api/wishlist/{kind}/{id}", a.moveTitle(true))
	mux.HandleFunc("GET /api/trash", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.library.titlesByTrashStatus(true))
	})
	mux.HandleFunc("POST /api/trash/{kind}/{id}/restore", a.moveTitle(false))
	mux.HandleFunc("DELETE /api/trash", func(w http.ResponseWriter, r *http.Request) {
		if err := a.library.emptyTrash(); err != nil {
			log.Printf("empty trash: %v", err)
			writeError(w, http.StatusInternalServerError, "Could not empty Trash.")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

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

func (a app) movieAvailability(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id < 1 || id > maxTMDBID {
		writeError(w, http.StatusBadRequest, "Select a valid film.")
		return
	}
	if _, found := a.library.find("movie", id); !found {
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
		if !current.Trashed {
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

func (a app) moveTitle(trashed bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		kind := r.PathValue("kind")
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil || id < 1 || id > maxTMDBID || !validKind(kind) {
			writeError(w, http.StatusBadRequest, "Select a valid film or TV show.")
			return
		}
		item, found, err := a.library.move(kind, id, trashed)
		if err != nil {
			log.Printf("save wishlist: %v", err)
			writeError(w, http.StatusInternalServerError, "Could not save the wishlist.")
			return
		}
		if trashed {
			w.WriteHeader(http.StatusNoContent)
		} else if !found {
			writeError(w, http.StatusNotFound, "This title is no longer in Trash.")
		} else {
			writeJSON(w, http.StatusOK, item)
		}
	}
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
	list, err := openLibrary(filepath.Join(env("DATA_DIR", "data"), "wishlist.json"))
	if err != nil {
		log.Fatalf("open wishlist: %v", err)
	}
	a := app{
		library: list,
		region:  region,
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
