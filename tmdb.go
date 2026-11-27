package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxTMDBID = 2147483647

var (
	imdbPattern     = regexp.MustCompile(`^tt[0-9]+$`)
	tmdbPattern     = regexp.MustCompile(`^[0-9]+$`)
	errNoCredential = errors.New("missing TMDB credential")
	errBadLookup    = errors.New("invalid lookup query")
)

type tmdb struct {
	base   string
	apiKey string
	client *http.Client
}

type remoteTitle struct {
	ID                  int      `json:"id"`
	Kind                string   `json:"media_type"`
	Title               string   `json:"title"`
	Name                string   `json:"name"`
	OriginalTitle       string   `json:"original_title"`
	OriginalName        string   `json:"original_name"`
	ReleaseDate         string   `json:"release_date"`
	FirstAirDate        string   `json:"first_air_date"`
	Status              string   `json:"status"`
	OriginalLanguage    string   `json:"original_language"`
	PosterPath          string   `json:"poster_path"`
	IMDbID              string   `json:"imdb_id"`
	OriginCountries     []string `json:"origin_country"`
	ProductionCountries []struct {
		Code string `json:"iso_3166_1"`
	} `json:"production_countries"`
	ExternalIDs struct {
		IMDbID string `json:"imdb_id"`
		TVDBID int    `json:"tvdb_id"`
	} `json:"external_ids"`
}

func (remote remoteTitle) toTitle(kind string) title {
	item := title{
		ID: remote.ID, Kind: kind, Name: remote.Title, OriginalName: remote.OriginalTitle,
		Date: remote.ReleaseDate, Status: remote.Status, OriginalLanguage: remote.OriginalLanguage,
		PosterPath: remote.PosterPath, IMDbID: remote.IMDbID,
		OriginCountries: remote.OriginCountries,
	}
	if len(item.OriginCountries) == 0 {
		for _, country := range remote.ProductionCountries {
			item.OriginCountries = append(item.OriginCountries, country.Code)
		}
	}
	if kind == "tv" {
		item.Name = remote.Name
		item.OriginalName = remote.OriginalName
		item.Date = remote.FirstAirDate
		item.IMDbID = remote.ExternalIDs.IMDbID
	}
	if item.Name == "" {
		item.Name = item.OriginalName
	}
	return item
}

type searchResult struct {
	Titles     []title `json:"titles"`
	Page       int     `json:"page"`
	TotalPages int     `json:"total_pages"`
}

type upstreamStatus int

func (code upstreamStatus) Error() string {
	return fmt.Sprintf("TMDB returned HTTP %d", code)
}

func (t tmdb) fetch(ctx context.Context, path string, query url.Values, result any) error {
	if t.apiKey == "" {
		return errNoCredential
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, t.base+path, nil)
	if err != nil {
		return err
	}
	parameters := request.URL.Query()
	for name, values := range query {
		parameters[name] = values
	}
	parameters.Set("language", "en-US")
	parameters.Set("api_key", t.apiKey)
	request.URL.RawQuery = parameters.Encode()
	request.Header.Set("Accept", "application/json")
	response, err := t.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return upstreamStatus(response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(result)
}

func (t tmdb) details(ctx context.Context, kind string, id int) (title, error) {
	path := "/movie/"
	query := url.Values{}
	if kind == "tv" {
		path = "/tv/"
		query.Set("append_to_response", "external_ids")
	}
	var remote remoteTitle
	err := t.fetch(ctx, path+strconv.Itoa(id), query, &remote)
	if err == nil && remote.ID != id {
		err = errors.New("TMDB returned an unexpected title ID")
	}
	item := remote.toTitle(kind)
	if kind == "tv" {
		item.TVDBID = &remote.ExternalIDs.TVDBID
	}
	if item.OriginCountries == nil {
		item.OriginCountries = []string{}
	}
	return item, err
}

type movieAvailability struct {
	Region           string `json:"region"`
	Theatrical       bool   `json:"theatrical"`
	TheatricalRegion string `json:"theatrical_region,omitempty"`
	Upcoming         bool   `json:"upcoming"`
	Streaming        bool   `json:"streaming"`
}

func (t tmdb) availability(ctx context.Context, id int, region string) (movieAvailability, error) {
	var releases struct {
		Results []struct {
			Region string `json:"iso_3166_1"`
			Dates  []struct {
				Type int    `json:"type"`
				Date string `json:"release_date"`
			} `json:"release_dates"`
		} `json:"results"`
	}
	var providers struct {
		Results map[string]struct {
			Subscription []json.RawMessage `json:"flatrate"`
			Free         []json.RawMessage `json:"free"`
			Ads          []json.RawMessage `json:"ads"`
		} `json:"results"`
	}
	path := "/movie/" + strconv.Itoa(id)
	var releaseErr, providerErr error
	var pending sync.WaitGroup
	pending.Go(func() { releaseErr = t.fetch(ctx, path+"/release_dates", nil, &releases) })
	pending.Go(func() { providerErr = t.fetch(ctx, path+"/watch/providers", nil, &providers) })
	pending.Wait()

	result := movieAvailability{Region: region}
	if releaseErr == nil {
		today := time.Now().UTC().Format(time.DateOnly)
		for _, release := range releases.Results {
			if release.Region == "" {
				continue
			}
			for _, date := range release.Dates {
				if date.Type != 2 && date.Type != 3 {
					continue
				}
				day, _, _ := strings.Cut(date.Date, "T")
				if _, err := time.Parse(time.DateOnly, day); err != nil {
					continue
				}
				if day > today {
					result.Upcoming = true
					continue
				}
				if result.TheatricalRegion == "" || release.Region == region {
					result.TheatricalRegion = release.Region
				}
				break
			}
		}
		result.Theatrical = result.TheatricalRegion != ""
		result.Upcoming = result.Upcoming && !result.Theatrical
	}
	if providerErr == nil {
		offers := providers.Results[region]
		result.Streaming = len(offers.Subscription)+len(offers.Free)+len(offers.Ads) > 0
	}
	if releaseErr != nil && providerErr != nil {
		return result, providerErr
	}
	return result, nil
}

func (t tmdb) search(ctx context.Context, query string, page int) (searchResult, error) {
	result := searchResult{Titles: []title{}, Page: 1, TotalPages: 1}
	lower := strings.ToLower(query)
	switch {
	case strings.HasPrefix(lower, "title:"):
		query = strings.TrimSpace(query[len("title:"):])
		if query == "" {
			return result, errBadLookup
		}
	case imdbPattern.MatchString(lower):
		var matches struct {
			Movies []remoteTitle `json:"movie_results"`
			TV     []remoteTitle `json:"tv_results"`
		}
		err := t.fetch(ctx, "/find/"+lower, url.Values{"external_source": {"imdb_id"}}, &matches)
		if errors.Is(err, upstreamStatus(http.StatusNotFound)) {
			return result, nil
		}
		for _, item := range matches.Movies {
			result.Titles = append(result.Titles, item.toTitle("movie"))
		}
		for _, item := range matches.TV {
			result.Titles = append(result.Titles, item.toTitle("tv"))
		}
		return result, err
	case tmdbPattern.MatchString(lower):
		id, err := strconv.ParseInt(query, 10, 32)
		if err != nil || id < 1 {
			return result, errBadLookup
		}
		var lookups [2]struct {
			item title
			err  error
		}
		var pending sync.WaitGroup
		for index, kind := range []string{"movie", "tv"} {
			pending.Go(func() {
				lookups[index].item, lookups[index].err = t.details(ctx, kind, int(id))
			})
		}
		pending.Wait()
		for _, lookup := range lookups {
			if errors.Is(lookup.err, upstreamStatus(http.StatusNotFound)) {
				continue
			}
			if lookup.err != nil {
				return result, lookup.err
			}
			result.Titles = append(result.Titles, lookup.item)
		}
		return result, nil
	}

	var matches struct {
		Results    []remoteTitle `json:"results"`
		TotalPages int           `json:"total_pages"`
	}
	err := t.fetch(ctx, "/search/multi", url.Values{
		"query": {query}, "page": {strconv.Itoa(page)}, "include_adult": {"false"},
	}, &matches)
	result.Page = page
	result.TotalPages = min(matches.TotalPages, 500)
	for _, item := range matches.Results {
		if validKind(item.Kind) && item.ID > 0 {
			result.Titles = append(result.Titles, item.toTitle(item.Kind))
		}
	}
	return result, err
}

func writeTMDBError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBadLookup):
		writeError(w, http.StatusBadRequest, "Enter a valid title or TMDB ID.")
	case errors.Is(err, errNoCredential):
		writeError(w, http.StatusServiceUnavailable, "Set TMDB_API_KEY in your .env file and restart the app to use search.")
	case errors.Is(err, upstreamStatus(http.StatusUnauthorized)), errors.Is(err, upstreamStatus(http.StatusForbidden)):
		writeError(w, http.StatusBadGateway, "TMDB rejected the API key. Check TMDB_API_KEY and restart the app.")
	case errors.Is(err, upstreamStatus(http.StatusNotFound)):
		writeError(w, http.StatusNotFound, "TMDB could not find that title.")
	case errors.Is(err, upstreamStatus(http.StatusTooManyRequests)):
		writeError(w, http.StatusTooManyRequests, "TMDB is receiving too many requests. Try again in a moment.")
	default:
		writeError(w, http.StatusBadGateway, "TMDB is temporarily unavailable. Try again in a moment.")
	}
}

type namedCredit struct {
	Name string `json:"name"`
}

type castCredit struct {
	Name        string `json:"name"`
	Character   string `json:"character"`
	ProfilePath string `json:"profile_path"`
	Roles       []struct {
		Character string `json:"character"`
	} `json:"roles,omitempty"`
}

type titleFacts struct {
	Overview            string        `json:"overview"`
	Tagline             string        `json:"tagline"`
	BackdropPath        string        `json:"backdrop_path"`
	Homepage            string        `json:"homepage"`
	Genres              []namedCredit `json:"genres"`
	ProductionCompanies []namedCredit `json:"production_companies"`
	SpokenLanguages     []struct {
		Name string `json:"english_name"`
	} `json:"spoken_languages"`
	VoteAverage      float64       `json:"vote_average"`
	VoteCount        int           `json:"vote_count"`
	Runtime          int           `json:"runtime"`
	EpisodeRuntime   []int         `json:"episode_run_time"`
	Budget           int64         `json:"budget"`
	Revenue          int64         `json:"revenue"`
	LastAirDate      string        `json:"last_air_date"`
	NumberOfSeasons  int           `json:"number_of_seasons"`
	NumberOfEpisodes int           `json:"number_of_episodes"`
	Networks         []namedCredit `json:"networks"`
	CreatedBy        []namedCredit `json:"created_by"`
	Seasons          []struct {
		Name         string `json:"name"`
		Overview     string `json:"overview"`
		PosterPath   string `json:"poster_path"`
		AirDate      string `json:"air_date"`
		EpisodeCount int    `json:"episode_count"`
		Number       int    `json:"season_number"`
	} `json:"seasons"`
}

type titlePage struct {
	title
	titleFacts
	Cast []castCredit `json:"cast"`
	Crew []struct {
		Name string `json:"name"`
		Job  string `json:"job"`
	} `json:"crew"`
}

func (t tmdb) fullDetails(ctx context.Context, item title) (titlePage, error) {
	var remote struct {
		remoteTitle
		titleFacts
		Credits struct {
			Cast []castCredit
			Crew []struct {
				Name string `json:"name"`
				Job  string `json:"job"`
			}
		}
		AggregateCredits struct {
			Cast []castCredit
		} `json:"aggregate_credits"`
	}
	appendToResponse := "external_ids,credits"
	if item.Kind == "tv" {
		appendToResponse += ",aggregate_credits"
	}
	if err := t.fetch(ctx, "/"+item.Kind+"/"+strconv.Itoa(item.ID), url.Values{
		"append_to_response": {appendToResponse},
	}, &remote); err != nil {
		return titlePage{}, err
	}
	if remote.ID != item.ID {
		return titlePage{}, errors.New("TMDB returned an unexpected title ID")
	}
	fresh := remote.toTitle(item.Kind)
	if !imdbPattern.MatchString(fresh.IMDbID) && imdbPattern.MatchString(remote.ExternalIDs.IMDbID) {
		fresh.IMDbID = remote.ExternalIDs.IMDbID
	}
	if !imdbPattern.MatchString(fresh.IMDbID) {
		fresh.IMDbID = item.IMDbID
	}
	if len(fresh.OriginCountries) == 0 {
		fresh.OriginCountries = item.OriginCountries
	}
	if item.Kind == "tv" {
		fresh.TVDBID = item.TVDBID
		if remote.ExternalIDs.TVDBID > 0 {
			fresh.TVDBID = &remote.ExternalIDs.TVDBID
		}
	}
	cast := remote.Credits.Cast
	if len(remote.AggregateCredits.Cast) > 0 {
		cast = remote.AggregateCredits.Cast
	}
	return titlePage{fresh, remote.titleFacts, cast, remote.Credits.Crew}, nil
}

var filmAffinityID = regexp.MustCompile(`^[0-9]{6,7}$`)

func lookupFilmAffinity(ctx context.Context, client *http.Client, item title) (string, error) {
	property := "P4947"
	if item.Kind == "tv" {
		property = "P4983"
	}
	matches := fmt.Sprintf("{ ?work wdt:%s %q }", property, strconv.Itoa(item.ID))
	if imdbPattern.MatchString(item.IMDbID) {
		matches += fmt.Sprintf(" UNION { ?work wdt:P345 %q }", item.IMDbID)
	}
	params := url.Values{
		"query":  {"SELECT DISTINCT ?id WHERE { " + matches + " ?work wdt:P480 ?id . } LIMIT 2"},
		"format": {"json"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://query.wikidata.org/sparql?"+params.Encode(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/sparql-results+json")
	req.Header.Set("User-Agent", "Listarr/1.0 (https://github.com/GonzaloArielRossi/listarr)")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Wikidata returned HTTP %d", resp.StatusCode)
	}
	var result struct {
		Results struct {
			Bindings []struct {
				ID struct{ Value string }
			}
		}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&result); err != nil {
		return "", err
	}
	if bindings := result.Results.Bindings; len(bindings) == 1 && filmAffinityID.MatchString(bindings[0].ID.Value) {
		return bindings[0].ID.Value, nil
	}
	return "", nil
}
