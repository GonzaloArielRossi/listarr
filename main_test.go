package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

type fakeTMDBTransport struct{}

func (fakeTMDBTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response := httptest.NewRecorder()
	fakeTMDB(response, request)
	return response.Result(), nil
}

func fakeTMDB(w http.ResponseWriter, r *http.Request) {
	const movie = `{"id":42,"media_type":"movie","title":"Summer Signal","original_language":"en","release_date":"2024-08-02","poster_path":"/signal.jpg","status":"Released","imdb_id":"tt1000042"}`
	const show = `{"id":42,"media_type":"tv","name":"Night Signal","original_name":"Signal de nuit","original_language":"fr","first_air_date":"2025-11-09","status":"Returning Series","external_ids":{"imdb_id":"tt2000042"}}`
	if r.URL.Query().Get("api_key") != "test-key" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/search/multi":
		switch r.URL.Query().Get("query") {
		case "Signal":
			_, _ = w.Write([]byte(`{"total_pages":2,"results":[` + movie + "," + show + `,{"id":42,"media_type":"person"}]}`))
		case "1917":
			_, _ = w.Write([]byte(`{"total_pages":1,"results":[{"id":1917,"media_type":"movie","title":"1917"}]}`))
		default:
			_, _ = w.Write([]byte(`{"total_pages":0,"results":[]}`))
		}
	case "/find/tt2000042":
		if r.URL.Query().Get("external_source") != "imdb_id" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"tv_results":[` + show + `]}`))
	case "/movie/42":
		_, _ = w.Write([]byte(movie))
	case "/tv/42":
		if r.URL.Query().Get("append_to_response") != "external_ids" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(show))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func TestWishlistFilmAndTV(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wishlist.json")
	list, err := openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	a := app{library: list, tmdb: tmdb{base: "https://tmdb.test", apiKey: "test-key", client: &http.Client{Transport: fakeTMDBTransport{}}}}
	handler := a.handler()

	request := func(t *testing.T, method, target, body string, wantStatus int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != wantStatus {
			t.Fatalf("%s %s returned %d, want %d: %s", method, target, response.Code, wantStatus, response.Body)
		}
		return response
	}

	for _, test := range []struct {
		query string
		kinds string
		pages int
	}{
		{"Signal", "movie,tv", 2},
		{"42", "movie,tv", 1},
		{"TT2000042", "tv", 1},
		{"title:1917", "movie", 1},
		{"999", "", 1},
	} {
		t.Run(test.query, func(t *testing.T) {
			response := request(t, "GET", "/api/search?q="+url.QueryEscape(test.query), "", 200)
			var result searchResult
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			kinds := make([]string, 0, len(result.Titles))
			for _, item := range result.Titles {
				kinds = append(kinds, item.Kind)
			}
			if strings.Join(kinds, ",") != test.kinds || result.TotalPages != test.pages {
				t.Fatalf("unexpected search result: %+v", result)
			}
		})
	}

	request(t, "POST", "/api/wishlist", `{"id":42,"media_type":"movie"}`, 201)
	request(t, "POST", "/api/wishlist", `{"id":42,"media_type":"tv"}`, 201)
	request(t, "POST", "/api/wishlist", `{"id":42,"media_type":"tv"}`, 200)

	a.library, err = openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	handler = a.handler()
	response := request(t, "GET", "/api/wishlist", "", 200)
	var items []title
	if err := json.Unmarshal(response.Body.Bytes(), &items); err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].Date != "2025-11-09" || items[0].Status != "Returning Series" ||
		items[0].OriginalLanguage != "fr" || items[0].IMDbID != "tt2000042" || items[1].PosterPath != "/signal.jpg" {
		t.Fatalf("unexpected saved metadata: %+v", items)
	}

	request(t, "DELETE", "/api/wishlist/tv/42", "", 204)
	request(t, "DELETE", "/api/wishlist/tv/42", "", 204)
	remaining, err := openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	if items := remaining.snapshot(); len(items) != 1 || items[0].Kind != "movie" || items[0].ID != 42 {
		t.Fatalf("removing the TV show affected the film: %+v", items)
	}
}
