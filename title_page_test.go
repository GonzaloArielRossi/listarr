package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func titlePageFixture(t *testing.T) app {
	t.Helper()
	dir := t.TempDir()
	list, err := openLibrary(filepath.Join(dir, "wishlist.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []title{
		{ID: 42, Kind: "movie", Name: "Summer Signal", IMDbID: "tt1000042", OriginCountries: []string{"CA"}},
		{ID: 42, Kind: "tv", Name: "Night Signal", OriginalName: "Signal de nuit", OriginalLanguage: "fr", IMDbID: "tt2000042", OriginCountries: []string{"FR"}},
		{ID: 45, Kind: "movie", Name: "Indigo", OriginCountries: []string{"ES"}},
	} {
		if _, _, err := list.add(item); err != nil {
			t.Fatal(err)
		}
	}
	return app{
		library: list,
		tmdb: tmdb{base: "https://tmdb.test", apiKey: "test-key", client: &http.Client{Transport: prowlarrTestTransport(func(req *http.Request) (*http.Response, error) {
			w := httptest.NewRecorder()
			query := req.URL.Query().Get("append_to_response")
			switch {
			case req.URL.Path == "/movie/42" && query == "external_ids,credits":
				fmt.Fprint(w, `{"id":42,"title":"Summer Signal","release_date":"2024-08-02","runtime":102,"genres":[{"name":"Drama"}],"overview":"A film about a radio signal.","status":"Released","vote_average":7.4,"vote_count":12,"production_countries":[{"iso_3166_1":"CA"}],"credits":{"cast":[{"name":"Alex Example","character":"The Operator"}],"crew":[{"name":"Dana Example","job":"Director"}]}}`)
			case req.URL.Path == "/tv/42" && query == "external_ids,credits,aggregate_credits":
				fmt.Fprint(w, `{"id":42,"name":"Night Signal","original_name":"Signal de nuit","original_language":"fr","first_air_date":"2025-11-09","origin_country":["FR"],"overview":"A series about a radio signal.","created_by":[{"name":"Dana Example"}],"external_ids":{"imdb_id":"tt2000042","tvdb_id":12345},"credits":{"cast":[{"name":"Guest Example"}]},"aggregate_credits":{"cast":[{"name":"Riley Example","roles":[{"character":"The Engineer"},{"character":"The Caller"}]}]},"number_of_seasons":1,"seasons":[{"name":"Season 1","episode_count":6,"season_number":1}]}`)
			default:
				fakeTMDB(w, req)
			}
			return w.Result(), nil
		})}},
		wikidata: &http.Client{Transport: prowlarrTestTransport(func(req *http.Request) (*http.Response, error) {
			w := httptest.NewRecorder()
			query := req.URL.Query().Get("query")
			switch {
			case req.URL.Host != "query.wikidata.org" || !strings.Contains(query, "wdt:P480"):
				w.WriteHeader(http.StatusBadRequest)
			case strings.Contains(query, `wdt:P4947 "42"`) && strings.Contains(query, `wdt:P345 "tt1000042"`):
				fmt.Fprint(w, `{"results":{"bindings":[{"id":{"value":"123456"}}]}}`)
			case strings.Contains(query, `wdt:P4983 "42"`) && strings.Contains(query, `wdt:P345 "tt2000042"`):
				fmt.Fprint(w, `{"results":{"bindings":[{"id":{"value":"654321"}}]}}`)
			default:
				fmt.Fprint(w, `{"results":{"bindings":[]}}`)
			}
			return w.Result(), nil
		})},
	}
}

func TestTitlePageAndExternalIDs(t *testing.T) {
	handler := titlePageFixture(t).handler()
	get := func(path string, status int) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != status {
			t.Fatalf("GET %s returned %d: %s", path, rec.Code, rec.Body.String())
		}
		return rec
	}
	if body := get("/title/tv/42", http.StatusOK).Body.String(); !strings.Contains(body, `<main id="title-page"`) || strings.Contains(body, `<dialog id="title-details"`) {
		t.Fatal("deep link did not serve the title page shell")
	}
	movie := get("/api/wishlist/movie/42/details", http.StatusOK)
	var film titlePage
	if err := json.Unmarshal(movie.Body.Bytes(), &film); err != nil {
		t.Fatal(err)
	}
	if film.Name != "Summer Signal" || film.IMDbID != "tt1000042" || film.Runtime != 102 || len(film.Cast) != 1 ||
		film.Cast[0].Character != "The Operator" || len(film.Crew) != 1 || film.Crew[0].Job != "Director" {
		t.Fatalf("unexpected film metadata: %+v", film)
	}
	show := get("/api/wishlist/tv/42/details", http.StatusOK)
	var series titlePage
	if err := json.Unmarshal(show.Body.Bytes(), &series); err != nil {
		t.Fatal(err)
	}
	if series.TVDBID == nil || *series.TVDBID != 12345 || len(series.Cast) != 1 || series.Cast[0].Name != "Riley Example" ||
		len(series.Cast[0].Roles) != 2 || len(series.Seasons) != 1 || series.Seasons[0].EpisodeCount != 6 {
		t.Fatalf("unexpected series metadata: %+v", series)
	}
	for path, id := range map[string]string{"movie/42": "123456", "tv/42": "654321", "movie/45": ""} {
		rec := get("/api/wishlist/"+path+"/filmaffinity", http.StatusOK)
		var result map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil || result["id"] != id {
			t.Fatalf("unexpected FilmAffinity lookup for %s: %s", path, rec.Body.String())
		}
	}
	get("/api/wishlist/tv/666/details", http.StatusNotFound)
}
