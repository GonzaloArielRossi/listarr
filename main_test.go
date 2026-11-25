package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
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
	const movie = `{"id":42,"media_type":"movie","title":"Summer Signal","original_language":"en","release_date":"2024-08-02","poster_path":"/signal.jpg","status":"Released","imdb_id":"tt1000042","origin_country":["CA","US"],"production_countries":[{"iso_3166_1":"MX"}]}`
	const show = `{"id":42,"media_type":"tv","name":"Night Signal","original_name":"Signal de nuit","original_language":"fr","first_air_date":"2025-11-09","status":"Returning Series","external_ids":{"imdb_id":"tt2000042"},"origin_country":["FR"]}`
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
	case "/movie/45":
		_, _ = w.Write([]byte(`{"id":45,"title":"Indigo","production_countries":[{"iso_3166_1":"ES"}]}`))
	case "/movie/42/release_dates":
		_, _ = w.Write([]byte(`{"results":[
			{"iso_3166_1":"AR","release_dates":[{"type":3,"release_date":"2024-08-02T00:00:00.000Z"}]},
			{"iso_3166_1":"GB","release_dates":[{"type":2,"release_date":"2024-08-05T00:00:00.000Z"}]},
			{"iso_3166_1":"CA","release_dates":[{"type":3,"release_date":"2099-01-01T00:00:00.000Z"},{"type":4,"release_date":"2024-08-02T00:00:00.000Z"}]}
		]}`))
	case "/movie/42/watch/providers":
		_, _ = w.Write([]byte(`{"results":{
			"AR":{"flatrate":[{"provider_id":1}]},
			"CA":{"rent":[{"provider_id":2}],"buy":[{"provider_id":3}]},
			"US":{"ads":[{"provider_id":4}]}
		}}`))
	case "/movie/43/release_dates":
		_, _ = w.Write([]byte(`{"results":[
			{"iso_3166_1":"ES","release_dates":[{"type":3,"release_date":"2099-01-01T00:00:00.000Z"}]}
		]}`))
	case "/movie/44/release_dates":
		_, _ = w.Write([]byte(`{"results":[
			{"iso_3166_1":"ES","release_dates":[{"type":1,"release_date":"2024-08-02T00:00:00.000Z"},{"type":4,"release_date":"2024-08-02T00:00:00.000Z"}]}
		]}`))
	case "/movie/43/watch/providers", "/movie/44/watch/providers":
		_, _ = w.Write([]byte(`{"results":{"AR":{"rent":[{"provider_id":2}]}}}`))
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

func TestMovieAvailability(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wishlist.json")
	list, err := openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{42, 43, 44} {
		if _, _, err := list.add(title{ID: id, Kind: "movie", Name: "Summer Signal", Status: "Released"}); err != nil {
			t.Fatal(err)
		}
	}
	a := app{library: list, tmdb: tmdb{base: "https://tmdb.test", apiKey: "test-key", client: &http.Client{Transport: fakeTMDBTransport{}}}}
	for _, test := range []struct {
		name string
		id   string
		want movieAvailability
	}{
		{"local release and streaming", "42", movieAvailability{Region: "AR", Theatrical: true, TheatricalRegion: "AR", Streaming: true}},
		{"prefer local limited release", "42", movieAvailability{Region: "GB", Theatrical: true, TheatricalRegion: "GB"}},
		{"theatrical release abroad and local rentals", "42", movieAvailability{Region: "CA", Theatrical: true, TheatricalRegion: "AR"}},
		{"theatrical release abroad and local free streaming", "42", movieAvailability{Region: "US", Theatrical: true, TheatricalRegion: "AR", Streaming: true}},
		{"upcoming theatrical release", "43", movieAvailability{Region: "AR", Upcoming: true}},
		{"premiere, digital release, and rental only", "44", movieAvailability{Region: "AR"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			want := test.want
			a.region = want.Region
			response := httptest.NewRecorder()
			a.handler().ServeHTTP(response, httptest.NewRequest("GET", "/api/wishlist/movie/"+test.id+"/availability", nil))
			if response.Code != http.StatusOK {
				t.Fatalf("unexpected status %d: %s", response.Code, response.Body)
			}
			var got movieAvailability
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil || got != want {
				t.Fatalf("got %+v, want %+v (error: %v)", got, want, err)
			}
		})
	}
}

func TestLegacyCardMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wishlist.json")
	const legacy = `[
		{"id":42,"media_type":"movie","imdb_id":"tt9999942","poster_path":"/legacy.jpg"},
		{"id":42,"media_type":"tv","trashed":true},
		{"id":45,"media_type":"movie"}
	]`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	list, err := openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	a := app{library: list, tmdb: tmdb{base: "https://tmdb.test", apiKey: "test-key", client: &http.Client{Transport: fakeTMDBTransport{}}}}
	handler := a.handler()
	for _, path := range []string{"movie/42", "tv/42", "movie/45"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/wishlist/"+path+"/metadata", nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d: %s", path, response.Code, response.Body)
		}
	}
	list, err = openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	movie, _ := list.find("movie", 42)
	show, _ := list.find("tv", 42)
	fallback, _ := list.find("movie", 45)
	if strings.Join(movie.OriginCountries, ",") != "CA,US" || movie.IMDbID != "tt9999942" ||
		movie.PosterPath != "/legacy.jpg" || movie.Date != "2024-08-02" ||
		strings.Join(show.OriginCountries, ",") != "FR" || show.IMDbID != "tt2000042" || !show.Trashed ||
		strings.Join(fallback.OriginCountries, ",") != "ES" {
		t.Fatalf("unexpected persisted metadata: %+v, %+v, %+v", movie, show, fallback)
	}
	handler = (app{library: list}).handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/wishlist/movie/42/metadata", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("persisted metadata required a TMDB request: %d: %s", response.Code, response.Body)
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
	readItems := func(path string) []title {
		t.Helper()
		response := request(t, "GET", path, "", 200)
		var items []title
		if err := json.Unmarshal(response.Body.Bytes(), &items); err != nil {
			t.Fatal(err)
		}
		if items == nil {
			t.Fatalf("%s returned null instead of an array", path)
		}
		return items
	}
	items := readItems("/api/wishlist")
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
	a.library = remaining
	handler = a.handler()
	if items := readItems("/api/trash"); len(items) != 1 || items[0].Kind != "tv" || items[0].IMDbID != "tt2000042" {
		t.Fatalf("trash did not preserve the removed show: %+v", items)
	}

	request(t, "POST", "/api/trash/tv/42/restore", "", 200)
	request(t, "POST", "/api/trash/tv/42/restore", "", 200)
	if items := readItems("/api/wishlist"); len(items) != 2 || items[0].Kind != "tv" {
		t.Fatalf("expected the restored show first in the wishlist: %+v", items)
	}
	if items := readItems("/api/trash"); len(items) != 0 {
		t.Fatalf("restored show is still in trash: %+v", items)
	}

	request(t, "DELETE", "/api/wishlist/tv/42", "", 204)
	a.tmdb = tmdb{}
	handler = a.handler()
	request(t, "POST", "/api/wishlist", `{"id":42,"media_type":"tv"}`, 201)
	if items := readItems("/api/trash"); len(items) != 0 {
		t.Fatalf("re-added show is still in trash: %+v", items)
	}
	request(t, "DELETE", "/api/wishlist/tv/42", "", 204)
	request(t, "DELETE", "/api/trash", "", 204)
	request(t, "DELETE", "/api/trash", "", 204)

	a.library, err = openLibrary(path)
	if err != nil {
		t.Fatal(err)
	}
	handler = a.handler()
	request(t, "POST", "/api/trash/tv/42/restore", "", 404)
	if items := readItems("/api/trash"); len(items) != 0 {
		t.Fatalf("trash still contains titles after emptying and reopening: %+v", items)
	}
	if items := readItems("/api/wishlist"); len(items) != 1 || items[0].Kind != "movie" {
		t.Fatalf("emptying trash affected the saved film: %+v", items)
	}
}
