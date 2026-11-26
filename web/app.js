const byId = (id) => document.getElementById(id);

const cards = byId("cards");
const titleFilter = byId("filter-title");
const languageFilter = byId("filter-language");
const typeFilters = [...document.querySelectorAll("[data-kind]")];
const layoutButtons = [...document.querySelectorAll(".layout-switch button")];
const displaySize = byId("display-size");
const listError = byId("list-error");
const searchTMDB = byId("search-tmdb");
const titleDetails = byId("title-details");
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
let selectedCard;
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
let prowlarrKind;
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
    if (titleDetails.open && selectedTitle === item) showDetailLinks(item);
  } catch {
    // Keep the fields already saved with the title.
  }
}

function poster(item, size) {
  const frame = element("div", "poster");
  frame.setAttribute("aria-hidden", "true");
  frame.append(icon("film-strip"));
  if (/^\/[\w-]+\.(jpe?g|png|webp)$/i.test(item.poster_path)) {
    const image = element("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => image.remove(), { once: true });
    image.src = "https://image.tmdb.org/t/p/" + size + item.poster_path;
    frame.append(image);
  }
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

  const action = element("button", "card-action");
  action.type = "button";
  action.dataset.key = keyFor(item);
  action.title = title;
  action.setAttribute("aria-label", "Details for " + title);
  action.setAttribute("aria-haspopup", "dialog");
  row.addEventListener("click", () => {
    if (!action.disabled) openDetails(item, row);
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
  for (const action of cards.querySelectorAll(".card-action")) action.disabled = busy;
}

function showDetailLinks(item) {
  const imdb = byId("details-imdb");
  imdb.hidden = !/^tt[0-9]+$/.test(item.imdb_id);
  if (!imdb.hidden) imdb.href = "https://www.imdb.com/title/" + item.imdb_id + "/";

  const catalog = byId("details-catalog");
  const hasTVDB = item.media_type === "tv" && Number.isInteger(item.tvdb_id) && item.tvdb_id > 0;
  catalog.href = hasTVDB ? "https://thetvdb.com/dereferrer/series/" + item.tvdb_id : "https://www.themoviedb.org/" + keyFor(item);
  catalog.title = hasTVDB ? "TVDB" : "TMDB";
  catalog.setAttribute("aria-label", catalog.title);
  byId("details-catalog-logo").src = hasTVDB ? "/tvdb.svg" : "/tmdb.svg";
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
  prowlarrKind = item.media_type;
  prowlarrQuery.value = displayTitle(item);
  prowlarrSearchDialog.showModal();
  searchProwlarr();
}

const torrentSize = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function renderTorrents(results, releases) {
  for (const release of releases) {
    const row = element("li");
    const link = element("a", "prowlarr-result");
    link.href = release.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const metadata = [release.indexer];
    if (release.size > 0) {
      const units = ["B", "KiB", "MiB", "GiB", "TiB"];
      const unit = Math.min(Math.floor(Math.log(release.size) / Math.log(1024)), units.length - 1);
      metadata.push(torrentSize.format(release.size / (1024 ** unit)) + " " + units[unit]);
    }
    if (release.seeders != null) {
      metadata.push(release.seeders + (release.seeders === 1 ? " seeder" : " seeders"));
    }
    link.append(element("span", "prowlarr-result-title", release.title));
    if (metadata.some(Boolean)) {
      link.append(element("span", "prowlarr-result-meta", metadata.filter(Boolean).join(" · ")));
    }
    row.append(link);
    results.append(row);
  }
}

async function searchProwlarr() {
  const query = prowlarrQuery.value.trim();
  if (!query) return;
  prowlarrRequest?.abort();
  const request = new AbortController();
  prowlarrRequest = request;
  const params = new URLSearchParams({ q: query, kind: prowlarrKind });
  const results = byId("prowlarr-results");
  const status = byId("prowlarr-search-status");
  const notice = byId("prowlarr-search-error");
  displayNotice(notice);
  results.replaceChildren();
  status.textContent = "Searching Prowlarr…";
  try {
    const releases = await api("/api/prowlarr/search?" + params, { signal: request.signal });
    if (request.signal.aborted) return;
    renderTorrents(results, releases);
    status.textContent = releases.length ? releases.length + (releases.length === 1 ? " torrent result" : " torrent results") : "No torrent results found.";
  } catch (error) {
    if (request.signal.aborted) return;
    status.textContent = "";
    displayNotice(notice, error.message);
  } finally {
    if (prowlarrRequest === request) prowlarrRequest = undefined;
  }
}

async function openDetails(item, row) {
  if (titleDetails.open) return;
  selectedTitle = item;
  selectedCard = row;
  byId("details-title").textContent = displayTitle(item);
  clearTimeout(copyToast);
  detailsFeedback.textContent = "";
  displayNotice(detailsError);
  showDetailLinks(item);
  titleDetails.showModal();
  if (item.origin_country == null || (item.media_type === "tv" && item.tvdb_id == null)) {
    try {
      await refreshMetadata(item);
      showCardMetadata(item, row.querySelector(".card-metadata"), row.querySelector(".card-origin"));
      if (titleDetails.open && selectedTitle === item) showDetailLinks(item);
    } catch {
      // Already-known links remain available.
    }
  }
}

async function copyTitle() {
  const title = displayTitle(selectedTitle);
  displayNotice(detailsError);
  try {
    await navigator.clipboard.writeText(title);
  } catch {
    const field = element("textarea", "sr-only");
    field.value = title;
    field.readOnly = true;
    titleDetails.append(field);
    field.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      // The title can still be selected in the dialog.
    }
    field.remove();
    byId("copy-title").focus();
    if (!copied) {
      displayNotice(detailsError, "Copy unavailable. Select and copy the title.");
      return;
    }
  }
  clearTimeout(copyToast);
  detailsFeedback.textContent = "Title copied.";
  copyToast = setTimeout(() => { detailsFeedback.textContent = ""; }, 2600);
}

async function deleteTitle(item, row) {
  if (changingList || pendingAdds.size) return;
  const key = keyFor(item);
  const nextKey = row.nextElementSibling?.querySelector(".card-action")?.dataset.key;
  changingList = true;
  updateListActions();
  displayNotice(detailsError);
  displayNotice(listError);
  try {
    await api("/api/wishlist/" + key, { method: "DELETE" });
    saved = saved.filter(other => keyFor(other) !== key);
    if (titleDetails.open && selectedTitle === item) titleDetails.close();
    changingList = false;
    updateLanguages();
    renderList();
    if (!titleDetails.open && !lookup.open && document.activeElement === document.body) {
      const actions = [...cards.querySelectorAll(".card-action")];
      (actions.find(button => button.dataset.key === nextKey) || actions[0] || titleFilter).focus();
    }
    byId("feedback").textContent = "Deleted " + displayTitle(item) + ".";
  } catch (error) {
    displayNotice(titleDetails.open && selectedTitle === item ? detailsError : listError, error.message);
  } finally {
    changingList = false;
    updateListActions();
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
byId("copy-title").addEventListener("click", copyTitle);
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
      if (item && titleDetails.open) openProwlarrSearch(item);
    }
  } catch (error) {
    displayNotice(notice, error.message);
  } finally {
    button.disabled = false;
  }
});
deleteButton.addEventListener("click", () => {
  const item = selectedTitle;
  const row = selectedCard;
  confirmAction("Delete this title?", "“" + displayTitle(item) + "” will be permanently deleted from your wishlist.", "Delete title", () => deleteTitle(item, row));
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
loadWishlist();
api("/api/prowlarr/settings").then(updateProwlarrConnection).catch(() => {});
