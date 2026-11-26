const byId = (id) => document.getElementById(id);

const cards = byId("cards");
const titleFilter = byId("filter-title");
const languageFilter = byId("filter-language");
const typeFilters = [...document.querySelectorAll("[data-kind]")];
const layoutButtons = [...document.querySelectorAll(".layout-switch button")];
const gridColumns = byId("grid-columns");
const listError = byId("list-error");
const showWishlist = byId("show-wishlist");
const showArchive = byId("show-archive");
const openLookup = byId("open-lookup");
const clearArchive = byId("clear-archive");
const confirmDialog = byId("confirm");
const lookup = byId("lookup");
const lookupQuery = byId("lookup-query");
const lookupStatus = byId("lookup-status");
const lookupError = byId("lookup-error");
const lookupResults = byId("lookup-results");
const previous = byId("previous-page");
const next = byId("next-page");

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
let archived = [];
let viewingArchive = false;
let typeFilter = "";
let confirmedAction;
let changingList = false;
let lookupRequest;
let completedQuery = "";
let currentPage = 1;
let totalPages = 1;
let loaded = false;

const keyFor = (item) => item.media_type + "/" + item.id;
const isSaved = (item) => saved.some((other) => keyFor(other) === keyFor(item));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
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

function applyDisplayOptions(layout) {
  cards.dataset.layout = layout;
  cards.dataset.columns = gridColumns.value;
  byId("grid-size").hidden = layout !== "grid";
  for (const button of layoutButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
  }
}

function saveDisplayOptions(layout) {
  applyDisplayOptions(layout);
  try {
    localStorage.setItem("listarr.display", JSON.stringify({ layout, columns: gridColumns.value }));
  } catch {
    // The current display still works when browser storage is unavailable.
  }
}

function loadDisplayOptions() {
  try {
    const preferences = JSON.parse(localStorage.getItem("listarr.display"));
    if (["4", "5", "6"].includes(preferences?.columns)) gridColumns.value = preferences.columns;
    applyDisplayOptions(preferences?.layout === "list" ? "list" : "grid");
  } catch {
    applyDisplayOptions("grid");
  }
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

async function loadCardMetadata(row) {
  const key = row.dataset.metadataKey;
  const item = (viewingArchive ? archived : saved).find(item => keyFor(item) === key);
  if (!item) return;
  try {
    const details = await loadCardData("/api/wishlist/" + key + "/metadata");
    item.origin_country = details.origin_country;
    item.imdb_id = details.imdb_id;
    item.release_date = details.release_date;
    showCardMetadata(item, row.querySelector(".card-metadata"), row.querySelector(".card-origin"));
  } catch {
    // Keep the fields already saved with the title.
  }
}

function poster(item, size) {
  const frame = element("div", "poster");
  frame.setAttribute("aria-hidden", "true");
  frame.append(element("span", "film-mark"));
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
  const media = element("span", "media-badge " + (film ? "media-film" : "media-tv"));
  media.setAttribute("role", "img");
  media.title = film ? "Film" : "TV show";
  media.setAttribute("aria-label", media.title);
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

  const label = viewingArchive ? "Restore" : "Archive";
  const action = element("button", viewingArchive ? "card-action" : "card-action archive", viewingArchive ? "↶" : "");
  if (!viewingArchive) action.append(element("span", "archive-icon"));
  action.type = "button";
  action.dataset.key = keyFor(item);
  action.title = label;
  action.setAttribute("aria-label", label + " " + title);
  action.addEventListener("click", () => {
    if (viewingArchive) {
      restoreTitle(item, action);
    } else {
      confirmAction("Archive this title?", "“" + title + "” will move to your archive. You can restore it anytime.", "Archive title", () => archiveTitle(item, action));
    }
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
  const items = viewingArchive ? archived : saved.filter((item) => (
    (!typeFilter || item.media_type === typeFilter) &&
    (!language || languageKey(item) === language) &&
    (!query || [item.title, item.original_title, item.id, item.imdb_id].some((text) => normalize(text).includes(query)))
  ));
  cardObserver.disconnect();
  cards.replaceChildren(...items.map(card));
  updateListActions();

  const total = viewingArchive ? archived.length : saved.length;
  const count = total + (total === 1 ? " title" : " titles");
  byId("summary").textContent = items.length === total ? count : items.length + " of " + count;
  byId("empty").hidden = items.length > 0;
  if (viewingArchive) {
    byId("empty-title").textContent = "Your archive is empty";
    byId("empty-detail").textContent = "Titles you archive from your wishlist appear here.";
  } else {
    byId("empty-title").textContent = total ? "No matching titles" : "Your wishlist is empty";
    byId("empty-detail").textContent = total
      ? "Try a different search or clear the filters."
      : "Use Add title to find your first film or TV show.";
  }
  byId("reset-filters").hidden = viewingArchive || !total;
}

function switchView(isArchive) {
  viewingArchive = isArchive;
  showWishlist.setAttribute("aria-pressed", String(!isArchive));
  showArchive.setAttribute("aria-pressed", String(isArchive));
  byId("view-title").textContent = isArchive ? "Archive" : "Wishlist";
  byId("view-detail").textContent = isArchive ? "Titles you’ve set aside. Restore them to your wishlist anytime." : "Films and TV shows you want to get.";
  byId("wishlist-filters").hidden = isArchive;
  openLookup.hidden = isArchive;
  clearArchive.hidden = !isArchive;
  if (loaded) displayNotice(listError);
  if (!loaded && listError.hidden) byId("summary").textContent = isArchive ? "Loading archive…" : "Loading wishlist…";
  renderList();
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
  openLookup.disabled = !loaded || changingList;
  clearArchive.disabled = !archived.length || busy;
  for (const action of cards.querySelectorAll(".card-action")) action.disabled = busy;
}

async function changeList(button, change) {
  if (changingList || pendingAdds.size) return;
  const startedInArchive = viewingArchive;
  const nextKey = button.closest("li")?.nextElementSibling?.querySelector(".card-action")?.dataset.key;
  changingList = true;
  updateListActions();
  displayNotice(listError);
  try {
    const message = await change();
    updateLanguages();
    const restoreFocus = startedInArchive === viewingArchive &&
      (document.activeElement === button || document.activeElement === document.body);
    changingList = false;
    renderList();
    if (restoreFocus) {
      const nextAction = [...cards.querySelectorAll(".card-action")].find((node) => node.dataset.key === nextKey);
      (nextAction || cards.querySelector(".card-action") || (viewingArchive ? showArchive : openLookup)).focus();
    }
    byId("feedback").textContent = message;
  } catch (error) {
    displayNotice(listError, error.message);
    changingList = false;
    updateListActions();
    if (startedInArchive === viewingArchive && document.activeElement === document.body) button.focus();
  }
}

function archiveTitle(item, button) {
  const key = keyFor(item);
  return changeList(button, async () => {
    await api("/api/wishlist/" + key + "/archive", { method: "POST" });
    saved = saved.filter((other) => keyFor(other) !== key);
    archived.unshift(item);
    return "Archived " + displayTitle(item) + ".";
  });
}

function restoreTitle(item, button) {
  const key = keyFor(item);
  return changeList(button, async () => {
    const restored = await api("/api/archive/" + key + "/restore", { method: "POST" });
    archived = archived.filter((other) => keyFor(other) !== key);
    if (!isSaved(restored)) saved.unshift(restored);
    return "Restored " + displayTitle(restored) + " to your wishlist.";
  });
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
    archived = archived.filter((other) => keyFor(other) !== key);
    displayNotice(listError);
    updateLanguages();
    renderList();
    const message = "Added " + displayTitle(added) + ".";
    if (lookupResults.contains(button)) {
      if (lookupQuery.value.trim() === completedQuery) {
        lookupQuery.value = "";
        lookupResults.replaceChildren();
        byId("pages").hidden = true;
        if (lookup.open) lookupQuery.focus();
      }
      lookupStatus.textContent = message;
    }
    if (!lookup.open) byId("feedback").textContent = message;
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

openLookup.addEventListener("click", () => {
  updateResultButtons();
  lookup.showModal();
});
lookup.addEventListener("close", () => {
  if (lookupRequest) {
    lookupRequest.abort();
    lookupRequest = undefined;
    lookupStatus.textContent = "";
  }
});
byId("lookup-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = lookupQuery.value.trim();
  if (query) search(query, 1);
});
previous.addEventListener("click", () => search(completedQuery, currentPage - 1));
next.addEventListener("click", () => search(completedQuery, currentPage + 1));
titleFilter.addEventListener("input", renderList);
languageFilter.addEventListener("change", renderList);
for (const button of layoutButtons) {
  button.addEventListener("click", () => saveDisplayOptions(button.dataset.layout));
}
gridColumns.addEventListener("change", () => saveDisplayOptions("grid"));
for (const button of typeFilters) {
  button.addEventListener("click", () => setTypeFilter(typeFilter === button.dataset.kind ? "" : button.dataset.kind));
}
byId("reset-filters").addEventListener("click", () => {
  titleFilter.value = "";
  languageFilter.value = "";
  setTypeFilter("");
  titleFilter.focus();
});
showWishlist.addEventListener("click", () => switchView(false));
showArchive.addEventListener("click", () => switchView(true));
clearArchive.addEventListener("click", () => {
  confirmAction("Clear the archive?", "All archived titles will be permanently deleted.", "Delete archived titles", () =>
    changeList(clearArchive, async () => {
      await api("/api/archive", { method: "DELETE" });
      archived = [];
      return "Archive cleared.";
    }));
});
confirmDialog.addEventListener("close", () => {
  const action = confirmedAction;
  confirmedAction = undefined;
  if (confirmDialog.returnValue === "confirm") action?.();
});

async function loadWishlist() {
  try {
    [saved, archived] = await Promise.all([api("/api/wishlist"), api("/api/archive")]);
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
