package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	prowlarrTimeout     = 55 * time.Second
	prowlarrResultLimit = 100
)

var prowlarrDownloadPath = regexp.MustCompile(`^/(?:api/v1/indexer/)?[0-9]+/download$`)

type prowlarrSettings struct {
	URL    string `json:"url"`
	APIKey string `json:"api_key"`
}

type prowlarrDownload struct {
	path    string
	query   url.Values
	expires time.Time
}

type prowlarr struct {
	mu        sync.Mutex
	path      string
	settings  prowlarrSettings
	downloads map[string]prowlarrDownload
	client    *http.Client
}

func openProwlarr(path string) (*prowlarr, error) {
	p := &prowlarr{
		path: path, downloads: make(map[string]prowlarrDownload),
		client: &http.Client{
			Timeout:       prowlarrTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &p.settings); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *prowlarr) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/prowlarr/settings", p.getSettings)
	mux.HandleFunc("PUT /api/prowlarr/settings", p.setSettings)
	mux.HandleFunc("GET /api/prowlarr/search", p.search)
	mux.HandleFunc("GET /api/prowlarr/download/{token}", p.download)
}

func (p *prowlarr) snapshot() prowlarrSettings {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.settings
}

func (p *prowlarr) getSettings(w http.ResponseWriter, _ *http.Request) {
	settings := p.snapshot()
	writeJSON(w, http.StatusOK, struct {
		URL       string `json:"url"`
		Connected bool   `json:"connected"`
	}{settings.URL, settings.APIKey != ""})
}

func (p *prowlarr) setSettings(w http.ResponseWriter, r *http.Request) {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "Expected JSON connection settings.")
		return
	}
	var settings prowlarrSettings
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	if err := decoder.Decode(&settings); err != nil || !errors.Is(decoder.Decode(new(any)), io.EOF) {
		writeError(w, http.StatusBadRequest, "Enter valid Prowlarr connection settings.")
		return
	}
	base, err := url.Parse(strings.TrimSpace(settings.URL))
	if err != nil || base.Hostname() == "" || (base.Scheme != "http" && base.Scheme != "https") ||
		base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		writeError(w, http.StatusBadRequest, "Enter the Prowlarr base URL, such as http://prowlarr:9696.")
		return
	}
	settings.URL = strings.TrimRight(base.String(), "/")
	settings.APIKey = strings.TrimSpace(settings.APIKey)
	current := p.snapshot()
	if settings.APIKey == "" && current.URL == settings.URL {
		settings.APIKey = current.APIKey
	}
	if settings.APIKey == "" || strings.ContainsAny(settings.APIKey, " \r\n\t") {
		writeError(w, http.StatusBadRequest, "Enter the API key from Prowlarr’s General settings.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var status struct{ AppName string }
	if err := p.fetch(ctx, settings, "/api/v1/system/status", nil, &status); err != nil {
		writeProwlarrError(w, err)
		return
	}
	if !strings.EqualFold(status.AppName, "Prowlarr") {
		writeError(w, http.StatusBadGateway, "The server at this URL did not identify itself as Prowlarr.")
		return
	}

	p.mu.Lock()
	err = saveJSON(p.path, settings)
	if err == nil {
		p.settings = settings
		clear(p.downloads)
	}
	p.mu.Unlock()
	if err != nil {
		log.Printf("save Prowlarr settings: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save the Prowlarr connection.")
		return
	}
	p.getSettings(w, r)
}

func (p *prowlarr) request(ctx context.Context, settings prowlarrSettings, path string, query url.Values) (*http.Response, error) {
	endpoint, err := url.Parse(settings.URL + path)
	if err != nil {
		return nil, err
	}
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Api-Key", settings.APIKey)
	return p.client.Do(req)
}

func (p *prowlarr) fetch(ctx context.Context, settings prowlarrSettings, path string, query url.Values, value any) error {
	response, err := p.request(ctx, settings, path, query)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return upstreamStatus(response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(value)
}

func writeProwlarrError(w http.ResponseWriter, err error) {
	if errors.Is(err, upstreamStatus(http.StatusUnauthorized)) || errors.Is(err, upstreamStatus(http.StatusForbidden)) {
		writeError(w, http.StatusBadGateway, "Prowlarr rejected the API key. Check the connection settings.")
		return
	}
	writeError(w, http.StatusBadGateway, "Could not reach Prowlarr or read its response. Check its URL and try again.")
}

type torrentResult struct {
	Title   string `json:"title"`
	Indexer string `json:"indexer"`
	Size    int64  `json:"size"`
	Seeders *int   `json:"seeders"`
	URL     string `json:"url"`
}

type trackerResult struct {
	Title      string `json:"title"`
	Indexer    string `json:"indexer"`
	Size       int64  `json:"size"`
	Seeders    *int   `json:"seeders"`
	Leechers   *int   `json:"leechers"`
	Age        *int   `json:"age"`
	Grabs      *int   `json:"grabs"`
	Protocol   string `json:"protocol"`
	TrackerURL string `json:"tracker_url"`
	Categories []struct {
		Name string `json:"name"`
	} `json:"categories"`
}

func (p *prowlarr) search(w http.ResponseWriter, r *http.Request) {
	settings := p.snapshot()
	if settings.APIKey == "" {
		writeError(w, http.StatusConflict, "Connect Prowlarr before searching.")
		return
	}
	kind := r.URL.Query().Get("kind")
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if !validKind(kind) || query == "" || utf8.RuneCountInString(query) > 256 {
		writeError(w, http.StatusBadRequest, "Enter a title to search for (up to 256 characters).")
		return
	}
	category := "2000"
	if kind == "tv" {
		category = "5000"
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(prowlarrTimeout + 5*time.Second))
	var releases []struct {
		trackerResult
		InfoURL     string
		CommentURL  string
		MagnetURL   string
		DownloadURL string
	}
	err := p.fetch(r.Context(), settings, "/api/v1/search", url.Values{
		"query": {query}, "type": {"search"}, "categories": {category},
	}, &releases)
	if err != nil {
		writeProwlarrError(w, err)
		return
	}

	if r.URL.Query().Get("view") == "tracker" {
		results := []trackerResult{}
		for _, release := range releases {
			if release.Title == "" || (release.Protocol != "torrent" && release.Protocol != "usenet") {
				continue
			}
			result := release.trackerResult
			result.TrackerURL = trackerPageURL(release.InfoURL, settings.APIKey)
			if result.TrackerURL == "" {
				result.TrackerURL = trackerPageURL(release.CommentURL, settings.APIKey)
			}
			results = append(results, result)
			if len(results) == prowlarrResultLimit {
				break
			}
		}
		writeJSON(w, http.StatusOK, results)
		return
	}

	results := []torrentResult{}
	base, _ := url.Parse(settings.URL)
	expires := time.Now().Add(30 * time.Minute)
	downloads := make(map[string]prowlarrDownload)
	for _, release := range releases {
		if release.Protocol != "torrent" || release.Title == "" {
			continue
		}
		result := torrentResult{Title: release.Title, Indexer: release.Indexer, Size: release.Size, Seeders: release.Seeders}
		for _, raw := range []string{release.MagnetURL, release.DownloadURL} {
			if target, err := url.Parse(raw); err == nil {
				path := strings.TrimPrefix(target.Path, strings.TrimRight(base.Path, "/"))
				values := target.Query()
				if prowlarrDownloadPath.MatchString(path) && values.Get("link") != "" {
					token := rand.Text()
					downloads[token] = prowlarrDownload{path, url.Values{"link": {values.Get("link")}, "file": {values.Get("file")}}, expires}
					result.URL = "/api/prowlarr/download/" + token
				} else {
					result.URL = torrentLink(raw, settings.APIKey)
				}
			}
			if result.URL != "" {
				break
			}
		}
		if result.URL != "" {
			results = append(results, result)
		}
		if len(results) == prowlarrResultLimit {
			break
		}
	}

	p.mu.Lock()
	if p.settings != settings {
		p.mu.Unlock()
		writeError(w, http.StatusConflict, "The Prowlarr connection changed. Search again.")
		return
	}
	for key, download := range p.downloads {
		if time.Now().After(download.expires) {
			delete(p.downloads, key)
		}
	}
	if len(p.downloads)+len(downloads) > 2000 {
		clear(p.downloads)
	}
	for key, download := range downloads {
		p.downloads[key] = download
	}
	p.mu.Unlock()
	writeJSON(w, http.StatusOK, results)
}

func safeProwlarrURL(raw, apiKey string) *url.URL {
	target, err := url.Parse(raw)
	if err != nil || target.User != nil || strings.Contains(raw, apiKey) ||
		strings.Contains(target.Path, apiKey) || strings.Contains(target.Fragment, apiKey) {
		return nil
	}
	for key, values := range target.Query() {
		if strings.EqualFold(key, "apikey") {
			return nil
		}
		for _, value := range values {
			if strings.Contains(value, apiKey) {
				return nil
			}
		}
	}
	return target
}

func trackerPageURL(raw, apiKey string) string {
	target := safeProwlarrURL(raw, apiKey)
	if target != nil && (target.Scheme == "http" || target.Scheme == "https") && target.Hostname() != "" {
		return target.String()
	}
	return ""
}

func torrentLink(raw, apiKey string) string {
	target := safeProwlarrURL(raw, apiKey)
	if target == nil {
		return ""
	}
	if target.Scheme == "magnet" {
		if hash := target.Query().Get("xt"); strings.HasPrefix(hash, "urn:btih:") || strings.HasPrefix(hash, "urn:btmh:") {
			return target.String()
		}
	}
	if (target.Scheme == "http" || target.Scheme == "https") && target.Hostname() != "" {
		return target.String()
	}
	return ""
}

var magnetPage = template.Must(template.New("magnet").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Open torrent · Listarr</title><main class="shell"><h1>Open torrent</h1><p><a class="button primary" href="{{.}}">Open magnet link</a></p></main></html>`))

func (p *prowlarr) download(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	settings := p.settings
	download, ok := p.downloads[r.PathValue("token")]
	p.mu.Unlock()
	if !ok || time.Now().After(download.expires) {
		http.Error(w, "This torrent link expired. Search again in Listarr.", http.StatusNotFound)
		return
	}

	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(prowlarrTimeout + 5*time.Second))
	query := url.Values{"link": download.query["link"], "file": download.query["file"], "apikey": {settings.APIKey}}
	response, err := p.request(r.Context(), settings, download.path, query)
	if err != nil {
		http.Error(w, "Could not open this torrent through Prowlarr.", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		if target := torrentLink(response.Header.Get("Location"), settings.APIKey); target != "" {
			if strings.HasPrefix(target, "magnet:") {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				// The link was validated by torrentLink. Use a page because browsers can block HTTP redirects to magnet URLs.
				_ = magnetPage.Execute(w, template.URL(target))
			} else {
				http.Redirect(w, r, target, http.StatusSeeOther)
			}
			return
		}
	}
	const maxTorrentSize = 8 << 20
	if response.StatusCode == http.StatusOK {
		data, err := io.ReadAll(io.LimitReader(response.Body, maxTorrentSize+1))
		if err == nil && len(data) <= maxTorrentSize {
			if bytes.HasPrefix(data, []byte("magnet:")) {
				if target := torrentLink(strings.TrimSpace(string(data)), settings.APIKey); target != "" {
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					_ = magnetPage.Execute(w, template.URL(target))
					return
				}
			}
			if len(data) > 2 && data[0] == 'd' && data[len(data)-1] == 'e' {
				w.Header().Set("Content-Type", "application/x-bittorrent")
				w.Header().Set("Content-Disposition", `attachment; filename="release.torrent"`)
				_, _ = w.Write(data)
				return
			}
		}
	}
	http.Error(w, "Prowlarr did not return a torrent. Try another result.", http.StatusBadGateway)
}
