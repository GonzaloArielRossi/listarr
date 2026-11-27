const byId = (id) => document.getElementById(id);

const cards = byId("cards");
const titleFilter = byId("filter-title");
const languageFilter = byId("filter-language");
const typeFilters = [...document.querySelectorAll("[data-kind]")];
const layoutButtons = [...document.querySelectorAll(".layout-switch button")];
const displaySize = byId("display-size");
const listError = byId("list-error");
const searchTMDB = byId("search-tmdb");
const titlePage = byId("title-page");
const wishlistView = byId("wishlist-view");
const detailsFeedback = byId("details-feedback");
const detailsError = byId("details-error");
const deleteButton = byId("delete-title");
const confirmDialog = byId("confirm");
const lookup = byId("lookup");
const lookupStatus = byId("lookup-status");
const lookupError = byId("lookup-error");
const lookupResults = byId("lookup-results");
const previous = byId("previous-page");
const next = byId("next-page");
const prowlarrSettingsDialog = byId("prowlarr-settings");
const prowlarrSearchDialog = byId("prowlarr-search");
const prowlarrNavbarButton = byId("open-prowlarr");
const prowlarrURL = byId("prowlarr-url");
const prowlarrKey = byId("prowlarr-key");
const prowlarrQuery = byId("prowlarr-query");

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const originalTitleLanguages = new Set(["en", "es", "it", "fr"]);
const pendingAdds = new Set();
const cardRequests = new Map();
const cardObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && entry.target.isConnected) {
      const row = entry.target;
      cardObserver.unobserve(row);
      if (row.dataset.movieId) showAvailability(row);
      if (row.dataset.metadataKey) loadCardMetadata(row);
    }
  }
}, { rootMargin: "200px" });
let saved = [];
let selectedTitle;
let copyToast;
let titleRequest;
let detailPath = "";
let wishlistScroll = 0;
let lastCard;
let gridColumns = "6";
let rowSize = "medium";
let typeFilter = "";
let confirmedAction;
let changingList = false;
let lookupRequest;
let completedQuery = "";
let currentPage = 1;
let totalPages = 1;
let loaded = false;
let prowlarrConnection = { connected: false, url: "" };
let waitingForProwlarr;
let prowlarrItem;
let prowlarrRequest;

const keyFor = (item) => item.media_type + "/" + item.id;
const isSaved = (item) => saved.some((other) => keyFor(other) === keyFor(item));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function icon(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const use = document.createElementNS(namespace, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", "/icons.svg#" + name);
  svg.append(use);
  return svg;
}

function displayNotice(node, message = "") {
  node.textContent = message;
  node.hidden = !message;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return;
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    throw new Error(data?.error || "The request failed. Please try again.");
  }
  return data;
}

function languageName(code) {
  if (!code || code === "xx") return "Unknown language";
  try {
    return languageNames.of(code) || code;
  } catch {
    return code;
  }
}

function languageKey(item) {
  return item.original_language || "xx";
}

function updateLanguages() {
  const selected = languageFilter.value;
  const codes = [...new Set(saved.map(languageKey))];
  codes.sort((a, b) => languageName(a).localeCompare(languageName(b)));
  languageFilter.replaceChildren(new Option("All original languages", ""));
  for (const code of codes) {
    languageFilter.add(new Option(languageName(code), code));
  }
  languageFilter.value = codes.includes(selected) ? selected : "";
}

function normalize(text) {
  return String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

const gridSizes = [["4", "4 per row"], ["5", "5 per row"], ["6", "6 per row"]];
const listSizes = [["compact", "Compact"], ["medium", "Medium"], ["large", "Large"]];

function applyDisplayOptions(layout) {
  const list = layout === "list";
  cards.dataset.layout = layout;
  cards.dataset.columns = gridColumns;
  cards.dataset.rowSize = rowSize;
  if (displaySize.dataset.layout !== layout) {
    displaySize.dataset.layout = layout;
    const sizes = list ? listSizes : gridSizes;
    displaySize.replaceChildren(...sizes.map(([value, label]) => new Option(label, value)));
    byId("display-size-label").textContent = list ? "List row size" : "Cards per row";
  }
  displaySize.value = list ? rowSize : gridColumns;
  for (const button of layoutButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
  }
}

function saveDisplayOptions(layout) {
  applyDisplayOptions(layout);
  try {
    localStorage.setItem("listarr.display", JSON.stringify({ layout, columns: gridColumns, rowSize }));
  } catch {
    // The current display still works when browser storage is unavailable.
  }
}

function loadDisplayOptions() {
  let layout = "grid";
  try {
    const preferences = JSON.parse(localStorage.getItem("listarr.display"));
    if (gridSizes.some(([value]) => value === preferences?.columns)) gridColumns = preferences.columns;
    if (listSizes.some(([value]) => value === preferences?.rowSize)) rowSize = preferences.rowSize;
    if (preferences?.layout === "list") layout = "list";
  } catch {
    // Keep the defaults if the saved preferences are unavailable.
  }
  applyDisplayOptions(layout);
}

function displayTitle(item) {
  if (originalTitleLanguages.has(item.original_language)) {
    return item.original_title || item.title;
  }
  return item.title || item.original_title;
}

function lookupMetadata(item) {
  const kind = item.media_type === "movie" ? "Film" : "TV show";
  const year = /^\d{4}/.exec(item.release_date)?.[0];
  return [kind, year || "Year unknown", languageName(item.original_language)].join(" · ");
}

function showCardMetadata(item, metadata, origin) {
  const year = /^\d{4}/.exec(item.release_date)?.[0] || "Year unknown";
  const countries = (item.origin_country || []).filter(code => /^[A-Z]{2}$/.test(code));
  origin.hidden = !countries.length;
  origin.textContent = countries.map(code => {
    const indicators = Array.from(code, letter => 0x1F1E6 + letter.charCodeAt(0) - 65);
    return String.fromCodePoint(...indicators);
  }).join(" ");
  origin.title = countries.map(code => regionNames.of(code)).join(", ");
  origin.setAttribute("aria-label", "Country of origin: " + origin.title);
  const fields = [year, "IMDb " + (item.imdb_id || "—"), "TMDB " + item.id];
  metadata.replaceChildren(...fields.map(field => {
    const line = element("p", "", field);
    line.title = field;
    return line;
  }));
}

function loadCardData(path) {
  if (!cardRequests.has(path)) {
    cardRequests.set(path, api(path).finally(() => cardRequests.delete(path)));
  }
  return cardRequests.get(path);
}

async function refreshMetadata(item) {
  const details = await loadCardData("/api/wishlist/" + keyFor(item) + "/metadata");
  item.origin_country = details.origin_country;
  item.imdb_id = details.imdb_id;
  item.tvdb_id = details.tvdb_id;
  item.release_date = details.release_date;
}

async function loadCardMetadata(row) {
  const item = saved.find(item => keyFor(item) === row.dataset.metadataKey);
  if (!item) return;
  try {
    await refreshMetadata(item);
    showCardMetadata(item, row.querySelector(".card-metadata"), row.querySelector(".card-origin"));
  } catch {
    // Keep the fields already saved with the title.
  }
}

function poster(item, size) {
  const frame = element("div", "poster");
  frame.setAttribute("aria-hidden", "true");
  frame.append(icon("film-strip"));
  const image = tmdbImage(item.poster_path, size);
  if (image) frame.append(image);
  return frame;
}

function card(item) {
  const row = element("li", "card");
  const cover = element("div", "card-cover");
  const body = element("div", "card-body");
  const title = displayTitle(item);
  const heading = element("h3", "", title);
  const info = element("div", "card-metadata");
  const origin = element("span", "card-origin");
  origin.setAttribute("role", "img");
  const film = item.media_type === "movie";
  const media = element("span", "media-badge");
  media.setAttribute("role", "img");
  media.title = film ? "Film" : "TV show";
  media.setAttribute("aria-label", media.title);
  media.append(icon(film ? "film-slate" : "television"));
  heading.title = title;
  showCardMetadata(item, info, origin);
  if (item.origin_country == null) row.dataset.metadataKey = keyFor(item);
  const status = element("span", "badge card-status");
  if (film) {
    row.dataset.movieId = item.id;
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = /^\d{4}-\d{2}-\d{2}$/.test(item.release_date) && item.release_date > today;
    status.textContent = upcoming ? "Upcoming" : "";
    status.hidden = !upcoming;
  } else {
    status.textContent = item.status === "Returning Series" ? "Returning" : item.status || "Status unknown";
    if (["Released", "Ended", "Returning Series"].includes(item.status)) {
      status.classList.add("released");
    }
  }
  if (row.dataset.movieId || row.dataset.metadataKey) cardObserver.observe(row);

  const action = element("a", "card-action");
  action.href = "/title/" + keyFor(item);
  action.dataset.key = keyFor(item);
  action.title = title;
  action.setAttribute("aria-label", "Details for " + title);
  action.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    lastCard = action;
    wishlistScroll = window.scrollY;
    history.pushState({ fromWishlist: true }, "", action.href);
    showCurrentPage(true);
  });
  cover.append(poster(item, "w342"), media, origin);
  body.append(heading, info, status);
  row.append(body, cover, action);
  return row;
}

async function showAvailability(row) {
  const id = row.dataset.movieId;
  const status = row.querySelector(".card-status");
  try {
    const { theatrical, theatrical_region, upcoming, streaming, region } =
      await loadCardData("/api/wishlist/movie/" + id + "/availability");
    if (streaming) {
      status.textContent = "Released";
      status.classList.add("released");
      status.title = "Available to stream in " + regionNames.of(region);
    } else if (theatrical) {
      status.textContent = "Released in Theaters";
      status.classList.add("theatrical");
      status.title = "Theatrical release in " + regionNames.of(theatrical_region || region);
    } else if (upcoming) {
      status.textContent = "Upcoming";
    }
    status.hidden = !status.textContent;
  } catch {
    // Keep any upcoming date from the saved title if availability cannot be loaded.
  }
}

function renderList() {
  if (!loaded) return;
  const query = normalize(titleFilter.value.trim());
  const language = languageFilter.value;
  const items = saved.filter((item) => (
    (!typeFilter || item.media_type === typeFilter) &&
    (!language || languageKey(item) === language) &&
    (!query || [item.title, item.original_title, item.id, item.imdb_id].some((text) => normalize(text).includes(query)))
  ));
  cardObserver.disconnect();
  cards.replaceChildren(...items.map(card));
  updateListActions();

  const total = saved.length;
  const count = total + (total === 1 ? " title" : " titles");
  byId("summary").textContent = items.length === total ? count : items.length + " of " + count;
  byId("empty").hidden = items.length > 0;
  byId("empty-title").textContent = total ? "No matching titles" : "Your wishlist is empty";
  byId("empty-detail").textContent = total
    ? "Try a different search, clear the filters, or search TMDB."
    : "Search TMDB to add your first title.";
  byId("reset-filters").hidden = !total;
}

function setTypeFilter(kind) {
  typeFilter = kind;
  for (const button of typeFilters) {
    button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
  }
  renderList();
}

function confirmAction(title, detail, label, action) {
  byId("confirm-title").textContent = title;
  byId("confirm-detail").textContent = detail;
  byId("confirm-action").textContent = label;
  confirmDialog.returnValue = "";
  confirmedAction = action;
  confirmDialog.showModal();
}

function updateListActions() {
  const busy = changingList || pendingAdds.size > 0;
  searchTMDB.disabled = !loaded || changingList;
  deleteButton.disabled = busy;
}

function updateProwlarrConnection(connection) {
  prowlarrConnection = connection;
  prowlarrNavbarButton.textContent = connection.connected ? "Prowlarr settings" : "Connect Prowlarr";
}

function openProwlarrSettings(item) {
  waitingForProwlarr = item;
  prowlarrURL.value = prowlarrConnection.url;
  prowlarrKey.value = "";
  prowlarrKey.required = !prowlarrConnection.connected;
  prowlarrKey.placeholder = prowlarrConnection.connected ? "Leave blank to keep saved key" : "";
  byId("prowlarr-settings-title").textContent = prowlarrNavbarButton.textContent;
  byId("save-prowlarr").textContent = prowlarrConnection.connected ? "Save connection" : "Connect";
  displayNotice(byId("prowlarr-settings-error"));
  prowlarrSettingsDialog.showModal();
}

function openProwlarrSearch(item) {
  if (!prowlarrConnection.connected) {
    openProwlarrSettings(item);
    return;
  }
  prowlarrItem = item;
  prowlarrQuery.value = displayTitle(item);
  renderProwlarrPresets(item);
  prowlarrSearchDialog.showModal();
  searchProwlarr(true);
}

function renderProwlarrPresets(item) {
  const presets = byId("prowlarr-presets");
  const focusedQuery = presets.contains(document.activeElement) ? document.activeElement.dataset.query : undefined;
  const title = displayTitle(item);
  const alternate = [item.original_title, item.title].find(name => name && name.trim().toLowerCase() !== title.trim().toLowerCase());
  const choices = [
    ["Title", title, true],
    ["Alternate title", alternate, true],
    ["IMDb", /^tt[0-9]+$/.test(item.imdb_id) ? item.imdb_id : ""],
    ["TMDB", item.id > 0 ? "tmdb:" + item.id : ""],
    ["TVDB", item.media_type === "tv" && item.tvdb_id > 0 ? "tvdb:" + item.tvdb_id : ""],
  ];
  const buttons = [];
  for (const [label, query, titleOnly] of choices) {
    if (!query) continue;
    const value = titleOnly ? query : query.split(":").at(-1);
    const button = element("button", "button secondary", label + " · " + value);
    button.type = "button";
    button.dataset.query = query;
    button.addEventListener("click", () => {
      prowlarrQuery.value = query;
      searchProwlarr(titleOnly);
    });
    buttons.push(button);
  }
  presets.replaceChildren(...buttons);
  if (focusedQuery) (buttons.find(button => button.dataset.query === focusedQuery) || prowlarrQuery).focus();
}

const torrentSize = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatSize(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return torrentSize.format(bytes / (1024 ** unit)) + " " + units[unit];
}

function renderTrackerResults(results, releases) {
  const format = new Intl.NumberFormat();
  const count = (value) => value == null ? "—" : format.format(value);
  for (const release of releases) {
    const row = element("tr");
    const protocol = element("td");
    protocol.append(element("span", "badge " + (release.protocol === "torrent" ? "released" : "theatrical"), release.protocol));
    const title = element("td", "tracker-title");
    if (release.tracker_url) {
      const link = element("a", "tracker-link", release.title);
      link.href = release.tracker_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      title.append(link);
    } else {
      title.textContent = release.title;
      title.title = "The indexer did not provide a tracker page.";
    }
    const peers = element("td");
    if (release.seeders != null || release.leechers != null) {
      const badge = element("span", "badge " + (release.seeders > 0 ? "released" : ""), count(release.seeders) + " / " + count(release.leechers));
      badge.title = "Seeders / leechers";
      peers.append(badge);
    } else {
      peers.textContent = "—";
    }
    const categories = element("td", "tracker-categories");
    const names = [...new Set((release.categories || []).map(category => category.name).filter(Boolean))];
    for (const name of names) categories.append(element("span", "badge", name));
    if (!names.length) categories.textContent = "—";
    row.append(protocol, element("td", "", release.age == null ? "—" : count(release.age) + (release.age === 1 ? " day" : " days")),
      title, element("td", "", release.indexer || "—"), element("td", "", formatSize(release.size)),
      element("td", "", count(release.grabs)), peers, categories);
    results.append(row);
  }
}

async function searchProwlarr(titleOnly = false) {
  const query = prowlarrQuery.value.trim();
  if (!query) return;
  prowlarrRequest?.abort();
  const request = new AbortController();
  prowlarrRequest = request;
  const params = new URLSearchParams({ q: query, kind: prowlarrItem.media_type, view: "tracker" });
  if (titleOnly) params.set("match", "title");
  const results = byId("prowlarr-results");
  const status = byId("prowlarr-search-status");
  const notice = byId("prowlarr-search-error");
  displayNotice(notice);
  results.replaceChildren();
  const table = byId("prowlarr-table");
  table.hidden = true;
  status.textContent = "Searching Prowlarr…";
  try {
    const releases = await api("/api/prowlarr/search?" + params, { signal: request.signal });
    if (request.signal.aborted) return;
    renderTrackerResults(results, releases);
    table.hidden = !releases.length;
    status.textContent = releases.length ? releases.length + (releases.length === 1 ? " result" : " results") : "No results found.";
  } catch (error) {
    if (request.signal.aborted) return;
    status.textContent = "";
    displayNotice(notice, error.message);
  } finally {
    if (prowlarrRequest === request) prowlarrRequest = undefined;
  }
}

function setOptionalText(id, text) {
  const node = byId(id);
  node.textContent = text || "";
  node.hidden = !text;
}

function tmdbImage(path, size) {
  if (!/^\/[\w-]+\.(jpe?g|png|webp)$/i.test(path || "")) return null;
  const image = element("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = "https://image.tmdb.org/t/p/" + size + path;
  return image;
}

function showTitleHeader(item) {
  const name = displayTitle(item);
  byId("details-title").textContent = name;
  document.title = name + " · Listarr";
  byId("details-poster").replaceChildren(poster(item, "w342"));
  const backdrop = tmdbImage(item.backdrop_path, "w1280");
  byId("details-backdrop").replaceChildren(...(backdrop ? [backdrop] : []));
  const runtime = item.runtime || item.episode_run_time?.[0];
  byId("details-summary").textContent = [
    item.release_date?.slice(0, 4), runtime > 0 ? runtime + " min" : "",
    item.status, ...(item.genres || []).map(genre => genre.name),
  ].filter(Boolean).join(" · ");
  const alternate = [item.original_title, item.title].find(value => value && value !== name);
  setOptionalText("details-original", alternate);
  setOptionalText("details-tagline", item.tagline);

  byId("details-external").hidden = false;
  const imdb = byId("details-imdb");
  imdb.hidden = !/^tt[0-9]+$/.test(item.imdb_id);
  if (!imdb.hidden) imdb.href = "https://www.imdb.com/title/" + item.imdb_id + "/";
  const filmAffinity = byId("details-filmaffinity");
  filmAffinity.href = "https://www.filmaffinity.com/es/advsearch.php";
  filmAffinity.setAttribute("aria-label", "Search FilmAffinity");
  filmAffinity.title = "Search FilmAffinity";
  filmAffinity.hidden = false;
  byId("details-tmdb").href = "https://www.themoviedb.org/" + keyFor(item);
  const tvdb = byId("details-tvdb");
  tvdb.hidden = item.media_type !== "tv" || !(item.tvdb_id > 0);
  if (!tvdb.hidden) tvdb.href = "https://thetvdb.com/dereferrer/series/" + item.tvdb_id;
  showCopyActions(item);
  byId("details-actions").hidden = false;
}

function showCopyActions(item) {
  const values = [
    ["Title", displayTitle(item)], ["TMDB ID", item.id],
    ["TVDB ID", item.tvdb_id > 0 ? item.tvdb_id : null],
    ["IMDb ID", /^tt[0-9]+$/.test(item.imdb_id) ? item.imdb_id : null],
  ];
  const actions = byId("details-copy");
  actions.hidden = false;
  actions.replaceChildren();
  for (const [label, value] of values) {
    if (value) actions.append(copyAction(label, String(value)));
  }
}

function copyAction(label, value) {
  const button = element("button", "button secondary");
  button.type = "button";
  button.setAttribute("aria-label", "Copy " + label);
  button.title = label === "Title" ? "Copy title" : "Copy " + value;
  button.append(icon("clipboard"), document.createTextNode(label));
  button.addEventListener("click", () => copyDetail(button, label, value));
  return button;
}

function addFacts(list, facts) {
  list.replaceChildren();
  for (const [label, value] of facts) {
    if (!value) continue;
    const row = element("div");
    const definition = element("dd");
    definition.append(value);
    row.append(element("dt", "", label), definition);
    list.append(row);
  }
}

const detailsDate = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" });
const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : detailsDate.format(date);
}

function renderTitleContent(item) {
  const names = (values, key = "name") => (values || []).map(value => value[key]).filter(Boolean).join(", ");
  const tv = item.media_type === "tv";
  const website = /^https?:\/\//i.test(item.homepage) ? element("a", "text-link", "Official website") : "";
  if (website) {
    website.href = item.homepage;
    website.target = "_blank";
    website.rel = "noopener noreferrer";
  }
  const facts = [
    [tv ? "First aired" : "Release date", formatDate(item.release_date)],
    ["Last aired", formatDate(item.last_air_date)],
    ["Country of origin", (item.origin_country || []).filter(code => /^[A-Z]{2}$/.test(code)).map(code => regionNames.of(code)).join(", ")],
    ["Original language", item.original_language ? languageName(item.original_language) : ""],
    ["Spoken languages", names(item.spoken_languages, "english_name")],
    ["Created by", names(item.created_by)],
    ["Networks", names(item.networks)],
    ["Production companies", names(item.production_companies)],
    ["Seasons", item.number_of_seasons || ""],
    ["Episodes", item.number_of_episodes || ""],
    ["TMDB rating", item.vote_count > 0 ? item.vote_average.toFixed(1) + " / 10 (" + item.vote_count.toLocaleString() + " votes)" : ""],
    ["Budget", item.budget > 0 ? dollars.format(item.budget) : ""],
    ["Revenue", item.revenue > 0 ? dollars.format(item.revenue) : ""],
    ["Website", website],
  ];
  byId("details-overview").textContent = item.overview || "No overview available.";
  addFacts(byId("details-facts"), facts);
  renderCast(item.cast || []);

  const crew = new Map();
  for (const { name, job } of item.crew || []) {
    if (!name || !job) continue;
    if (!crew.has(job)) crew.set(job, new Set());
    crew.get(job).add(name);
  }
  const priority = ["Director", "Writer", "Screenplay", "Producer", "Executive Producer", "Original Music Composer", "Director of Photography"];
  const jobs = [...new Set([...priority, ...crew.keys()])];
  addFacts(byId("details-crew"), jobs.filter(job => crew.has(job)).map(job => [job, [...crew.get(job)].join(", ")]));
  byId("crew-section").hidden = !crew.size;

  const seasons = byId("details-seasons");
  seasons.replaceChildren();
  for (const season of item.seasons || []) {
    const row = element("li", "season-card");
    const image = tmdbImage(season.poster_path, "w185");
    const info = element("div");
    info.append(element("h3", "", season.name));
    const date = [formatDate(season.air_date), season.episode_count > 0 ? season.episode_count + (season.episode_count === 1 ? " episode" : " episodes") : ""].filter(Boolean).join(" · ");
    if (date) info.append(element("p", "title-original", date));
    if (season.overview) info.append(element("p", "", season.overview));
    if (image) row.append(image);
    row.append(info);
    seasons.append(row);
  }
  byId("seasons-section").hidden = !seasons.childElementCount;
  byId("details-content").hidden = false;
}

function renderCast(cast) {
  const list = byId("details-cast");
  const showAll = byId("show-all-cast");
  list.replaceChildren();
  byId("cast-section").hidden = !cast.length;
  const addCast = (members) => {
    for (const member of members) {
      const row = element("li");
      const portrait = element("div", "cast-portrait");
      const image = tmdbImage(member.profile_path, "w185");
      if (image) portrait.append(image);
      const roles = member.roles?.map(role => role.character).filter(Boolean).join(", ") || member.character;
      row.append(portrait, element("strong", "", member.name), element("span", "", roles));
      list.append(row);
    }
  };
  addCast(cast.slice(0, 12));
  showAll.hidden = cast.length <= 12;
  showAll.textContent = "Show all " + cast.length + " cast members";
  showAll.onclick = () => {
    addCast(cast.slice(12));
    showAll.hidden = true;
    const nextCast = list.children[12];
    nextCast.tabIndex = -1;
    nextCast.focus();
  };
}

async function copyDetail(button, label, value) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(value);
    copied = true;
  } catch {
    const field = element("textarea", "sr-only");
    field.value = value;
    field.readOnly = true;
    titlePage.append(field);
    field.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      // Announce that the clipboard is unavailable.
    }
    field.remove();
    button.focus();
  }
  if (titlePage.hidden) return;
  clearTimeout(copyToast);
  detailsFeedback.textContent = copied ? label + " copied." : "Clipboard unavailable.";
  copyToast = setTimeout(() => { detailsFeedback.textContent = ""; }, 2600);
}

async function showCurrentPage(focus = false) {
  const path = location.pathname;
  if (path === detailPath) return;
  detailPath = path;
  titleRequest?.abort();
  if (prowlarrSearchDialog.open) prowlarrSearchDialog.close();
  const match = /^\/title\/(movie|tv)\/(\d+)$/.exec(path);
  const key = match ? match[1] + "/" + match[2] : "";
  const isTitle = path.startsWith("/title/");
  titlePage.hidden = !isTitle;
  wishlistView.hidden = isTitle;
  selectedTitle = undefined;
  if (!isTitle) {
    document.title = "Listarr";
    if (focus) {
      (lastCard?.isConnected ? lastCard : titleFilter).focus({ preventScroll: true });
      window.scrollTo(0, wishlistScroll);
    }
    return;
  }

  const loading = byId("details-loading");
  displayNotice(detailsError);
  clearTimeout(copyToast);
  detailsFeedback.textContent = "";
  byId("details-title").textContent = "Title details";
  byId("details-summary").textContent = "";
  byId("details-poster").replaceChildren();
  byId("details-backdrop").replaceChildren();
  for (const id of ["details-content", "details-external", "details-copy", "details-actions", "details-original", "details-tagline", "filmaffinity-status"]) {
    byId(id).hidden = true;
  }
  document.title = "Title details · Listarr";
  if (focus) {
    window.scrollTo(0, 0);
    byId("details-title").focus({ preventScroll: true });
  }
  if (!key) {
    loading.textContent = "";
    displayNotice(detailsError, "This title page does not exist.");
    return;
  }
  selectedTitle = saved.find(item => keyFor(item) === key);
  if (selectedTitle) showTitleHeader(selectedTitle);
  loading.textContent = "Loading title details…";
  const request = new AbortController();
  titleRequest = request;
  const options = { signal: request.signal };
  const endpoint = "/api/wishlist/" + key;
  const affinity = api(endpoint + "/filmaffinity", options).then(({ id }) => ({ id }), () => ({ failed: true }));
  try {
    const item = await api(endpoint + "/details", options);
    if (request.signal.aborted) return;
    selectedTitle = item;
    showTitleHeader(item);
    if (prowlarrSearchDialog.open && keyFor(prowlarrItem) === keyFor(item)) renderProwlarrPresets(item);
    renderTitleContent(item);
  } catch (error) {
    if (!request.signal.aborted) displayNotice(detailsError, error.message);
  } finally {
    if (!request.signal.aborted) loading.textContent = "";
  }
  const result = await affinity;
  if (request.signal.aborted || !selectedTitle) return;
  if (result.id) {
    const filmAffinity = byId("details-filmaffinity");
    filmAffinity.href = "https://www.filmaffinity.com/es/film" + result.id + ".html";
    filmAffinity.setAttribute("aria-label", "FilmAffinity");
    filmAffinity.title = "FilmAffinity";
    byId("details-copy").append(copyAction("FilmAffinity ID", result.id));
  } else {
    setOptionalText("filmaffinity-status", result.failed ? "FilmAffinity lookup temporarily unavailable." : "No FilmAffinity ID match found.");
  }
}

async function deleteTitle(item) {
  if (changingList || pendingAdds.size) return;
  const key = keyFor(item);
  changingList = true;
  updateListActions();
  displayNotice(detailsError);
  displayNotice(listError);
  try {
    await api("/api/wishlist/" + key, { method: "DELETE" });
    saved = saved.filter(other => keyFor(other) !== key);
    updateLanguages();
    renderList();
    if (selectedTitle && keyFor(selectedTitle) === key) returnToWishlist();
    byId("feedback").textContent = "Deleted " + displayTitle(item) + ".";
  } catch (error) {
    displayNotice(!titlePage.hidden ? detailsError : listError, error.message);
  } finally {
    changingList = false;
    updateListActions();
  }
}

function returnToWishlist() {
  if (history.state?.fromWishlist) {
    history.back();
  } else {
    history.replaceState(null, "", "/");
    showCurrentPage(true);
  }
}

function updateResultButtons() {
  for (const button of lookupResults.querySelectorAll("button")) {
    const alreadySaved = saved.some((item) => keyFor(item) === button.dataset.key);
    const adding = pendingAdds.has(button.dataset.key);
    button.textContent = alreadySaved ? "Added" : adding ? "Adding…" : "Add";
    button.setAttribute("aria-disabled", String(alreadySaved || adding));
    button.setAttribute("aria-label", button.textContent + " " + button.dataset.title);
  }
}

async function addTitle(item, button) {
  const key = keyFor(item);
  if (isSaved(item) || pendingAdds.has(key) || changingList) return;
  pendingAdds.add(key);
  updateResultButtons();
  updateListActions();
  displayNotice(lookupError);
  try {
    const added = await api("/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, media_type: item.media_type }),
    });
    if (!isSaved(added)) saved.unshift(added);
    const resetSearch = lookupResults.contains(button) && titleFilter.value.trim() === completedQuery;
    if (resetSearch) titleFilter.value = "";
    displayNotice(listError);
    updateLanguages();
    renderList();
    if (resetSearch && lookup.open) {
      lookup.close();
      titleFilter.focus();
    }
    if (!lookup.open) byId("feedback").textContent = "Added " + displayTitle(added) + ".";
  } catch (error) {
    displayNotice(lookup.open ? lookupError : listError, error.message);
  } finally {
    pendingAdds.delete(key);
    updateResultButtons();
    updateListActions();
  }
}

function resultRow(item) {
  const row = element("li", "result");
  const body = element("div");
  const button = element("button", "button secondary", "Add");
  const title = displayTitle(item);
  button.type = "button";
  button.dataset.key = keyFor(item);
  button.dataset.title = title;
  button.addEventListener("click", () => addTitle(item, button));
  body.append(element("strong", "", title), element("p", "metadata", lookupMetadata(item)));
  row.append(poster(item, "w92"), body, button);
  return row;
}

async function search(query, page) {
  lookupRequest?.abort();
  const request = new AbortController();
  lookupRequest = request;
  lookupResults.replaceChildren();
  byId("pages").hidden = true;
  displayNotice(lookupError);
  lookupStatus.textContent = "Searching TMDB…";
  const parameters = new URLSearchParams({ q: query, page });
  try {
    const results = await api("/api/search?" + parameters, { signal: request.signal });
    if (request.signal.aborted) return;
    completedQuery = query;
    currentPage = results.page;
    totalPages = results.total_pages;
    lookupResults.replaceChildren(...results.titles.map(resultRow));
    updateResultButtons();
    lookupStatus.textContent = results.titles.length
      ? results.titles.length + (results.titles.length === 1 ? " result" : " results")
      : totalPages > 1 ? "No films or TV shows on this page." : "No films or TV shows found.";
    byId("pages").hidden = totalPages <= 1;
    previous.disabled = currentPage <= 1;
    next.disabled = currentPage >= totalPages;
    byId("page-number").textContent = "Page " + currentPage + " of " + totalPages;
  } catch (error) {
    if (request.signal.aborted) return;
    lookupStatus.textContent = "";
    displayNotice(lookupError, error.message);
  } finally {
    if (lookupRequest === request) lookupRequest = undefined;
  }
}

lookup.addEventListener("close", () => {
  if (lookupRequest) {
    lookupRequest.abort();
    lookupRequest = undefined;
    lookupStatus.textContent = "";
  }
});
byId("title-search").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = titleFilter.value.trim();
  if (!query || searchTMDB.disabled) return;
  lookup.showModal();
  search(query, 1);
});
previous.addEventListener("click", () => search(completedQuery, currentPage - 1));
next.addEventListener("click", () => search(completedQuery, currentPage + 1));
titleFilter.addEventListener("input", renderList);
languageFilter.addEventListener("change", renderList);
for (const button of layoutButtons) {
  button.addEventListener("click", () => saveDisplayOptions(button.dataset.layout));
}
displaySize.addEventListener("change", () => {
  const layout = cards.dataset.layout;
  if (layout === "list") rowSize = displaySize.value;
  else gridColumns = displaySize.value;
  saveDisplayOptions(layout);
});
for (const button of typeFilters) {
  button.addEventListener("click", () => setTypeFilter(typeFilter === button.dataset.kind ? "" : button.dataset.kind));
}
byId("reset-filters").addEventListener("click", () => {
  titleFilter.value = "";
  languageFilter.value = "";
  setTypeFilter("");
  titleFilter.focus();
});
window.addEventListener("popstate", () => showCurrentPage(true));
byId("back-to-wishlist").addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  returnToWishlist();
});
prowlarrNavbarButton.addEventListener("click", () => openProwlarrSettings());
byId("search-prowlarr").addEventListener("click", () => openProwlarrSearch(selectedTitle));
byId("prowlarr-query-form").addEventListener("submit", (event) => {
  event.preventDefault();
  searchProwlarr();
});
prowlarrSearchDialog.addEventListener("close", () => prowlarrRequest?.abort());
prowlarrSettingsDialog.addEventListener("close", () => {
  prowlarrKey.value = "";
  waitingForProwlarr = undefined;
});
byId("prowlarr-connection").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("save-prowlarr");
  const notice = byId("prowlarr-settings-error");
  if (button.disabled) return;
  button.disabled = true;
  displayNotice(notice);
  try {
    const connection = await api("/api/prowlarr/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: prowlarrURL.value.trim(), api_key: prowlarrKey.value }),
    });
    updateProwlarrConnection(connection);
    if (prowlarrSettingsDialog.open) {
      const item = waitingForProwlarr;
      prowlarrSettingsDialog.close();
      if (item && selectedTitle && keyFor(item) === keyFor(selectedTitle)) openProwlarrSearch(selectedTitle);
    }
  } catch (error) {
    displayNotice(notice, error.message);
  } finally {
    button.disabled = false;
  }
});
deleteButton.addEventListener("click", () => {
  const item = selectedTitle;
  if (!item) return;
  confirmAction("Delete this title?", "“" + displayTitle(item) + "” will be permanently deleted from your wishlist.", "Delete title", () => deleteTitle(item));
});
confirmDialog.addEventListener("close", () => {
  const action = confirmedAction;
  confirmedAction = undefined;
  if (confirmDialog.returnValue === "confirm") action?.();
});

async function loadWishlist() {
  try {
    saved = await api("/api/wishlist");
    loaded = true;
    updateLanguages();
    renderList();
    updateResultButtons();
  } catch (error) {
    byId("summary").textContent = "Library unavailable";
    displayNotice(listError, error.message);
  }
}

loadDisplayOptions();
if (location.pathname.startsWith("/title/")) {
  wishlistView.hidden = true;
  titlePage.hidden = false;
}
loadWishlist().then(() => showCurrentPage());
api("/api/prowlarr/settings").then(updateProwlarrConnection).catch(() => {});
