package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type prowlarrTestTransport func(*http.Request) (*http.Response, error)

func (f prowlarrTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestProwlarrManualSearch(t *testing.T) {
	const key = "prowlarr-fixture-key-42"
	const base = "http://prowlarr.test:9696/arr"
	const magnet = "magnet:?xt=urn:btih:12345"
	const torrent = "d4:infodee"
	path := filepath.Join(t.TempDir(), "prowlarr.json")
	p, err := openProwlarr(path)
	if err != nil {
		t.Fatal(err)
	}
	p.client.Transport = prowlarrTestTransport(func(req *http.Request) (*http.Response, error) {
		if req.Method != "GET" || req.URL.Host != "prowlarr.test:9696" {
			t.Fatalf("unexpected Prowlarr request: %s %s", req.Method, req.URL)
		}
		response := func(status int, body string) *http.Response {
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
		}
		if req.Header.Get("X-Api-Key") != key {
			return response(http.StatusUnauthorized, ""), nil
		}
		query := req.URL.Query()
		switch req.URL.Path {
		case "/arr/api/v1/system/status":
			return response(http.StatusOK, `{"appName":"Prowlarr"}`), nil
		case "/arr/api/v1/search":
			wantCategory := map[string]string{"Mi película": "2000", "La serie": "5000"}
			if wantCategory[query.Get("query")] != query.Get("categories") || query.Get("type") != "search" {
				t.Fatalf("unexpected Prowlarr search parameters: %s", req.URL.RawQuery)
			}
			return response(http.StatusOK, `[
			  {"title":"Fixture film 1080p","indexer":"Fixture","size":1073741824,"seeders":8,"protocol":"torrent","downloadUrl":"https://proxied.test/arr/9/download?apikey=`+key+`&link=opaque-torrent&file=Fixture+film"},
			  {"title":"Fixture film 720p","seeders":0,"protocol":"torrent","magnetUrl":"http://prowlarr.test:9696/arr/9/download?apikey=`+key+`&link=opaque-magnet"},
			  {"title":"Direct magnet","protocol":"torrent","magnetUrl":"`+magnet+`"},
			  {"title":"Usenet release","protocol":"usenet","downloadUrl":"https://indexer.test/fixture"},
			  {"title":"Invalid link","protocol":"torrent","downloadUrl":"javascript:alert(1)"},
			  {"title":"Credential in link","protocol":"torrent","downloadUrl":"https://indexer.test/fixture?api%6bey=secret"}
			]`), nil
		case "/arr/9/download":
			if query.Get("apikey") != key {
				t.Fatal("missing proxy download authentication")
			}
			switch query.Get("link") {
			case "opaque-torrent":
				if query.Get("file") != "Fixture film" {
					t.Fatal("missing download file parameter")
				}
				return response(http.StatusOK, torrent), nil
			case "opaque-magnet":
				res := response(http.StatusFound, "")
				res.Header.Set("Location", magnet)
				return res, nil
			}
		}
		t.Fatalf("unexpected Prowlarr endpoint: %s", req.URL.Path)
		return nil, nil
	})

	handler := (app{prowlarr: p}).handler()
	call := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != status || strings.Contains(rec.Body.String(), key) {
			t.Fatalf("%s %s returned status %d or leaked credentials", method, path, rec.Code)
		}
		return rec
	}
	call("GET", "/api/prowlarr/search?kind=movie&q=Film", "", http.StatusConflict)
	call("PUT", "/api/prowlarr/settings", `{"url":"`+base+`/","api_key":"`+key+`"}`, http.StatusOK)
	call("PUT", "/api/prowlarr/settings", `{"url":"`+base+`","api_key":"wrong"}`, http.StatusBadGateway)
	if result := call("GET", "/api/prowlarr/settings", "", http.StatusOK).Body.String(); !strings.Contains(result, `"connected":true`) || strings.Contains(result, "api_key") {
		t.Fatalf("unexpected public connection status: %s", result)
	}

	reopened, err := openProwlarr(path)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.snapshot() != (prowlarrSettings{URL: base, APIKey: key}) {
		t.Fatal("the verified connection did not survive restart")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("connection file permissions = %v", info.Mode().Perm())
	}

	releases := call("GET", "/api/prowlarr/search?kind=movie&q=Mi+pel%C3%ADcula", "", http.StatusOK)
	call("GET", "/api/prowlarr/search?kind=tv&q=La+serie", "", http.StatusOK)
	var results []torrentResult
	if err := json.Unmarshal(releases.Body.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 3 || results[0].Title != "Fixture film 1080p" || results[0].Indexer != "Fixture" || results[0].Size != 1073741824 || results[0].Seeders == nil || *results[0].Seeders != 8 || results[2].URL != magnet {
		t.Fatalf("unexpected torrent results: %+v", results)
	}
	for _, release := range results[:2] {
		if !strings.HasPrefix(release.URL, "/api/prowlarr/download/") || strings.Contains(release.URL, "opaque-") {
			t.Fatalf("unexpected public download link: %s", release.URL)
		}
	}
	file := call("GET", results[0].URL, "", http.StatusOK)
	if file.Body.String() != torrent || file.Header().Get("Content-Type") != "application/x-bittorrent" || !strings.HasPrefix(file.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("expected a torrent attachment")
	}
	page := call("GET", results[1].URL, "", http.StatusOK)
	if !strings.Contains(page.Body.String(), `href="`+magnet+`"`) {
		t.Fatalf("expected a magnet launch link: %s", page.Body.String())
	}

	call("PUT", "/api/prowlarr/settings", `{"url":"`+base+`"}`, http.StatusOK)
	call("GET", results[0].URL, "", http.StatusNotFound)
}
