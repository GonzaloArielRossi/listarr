const byId = (id) => document.getElementById(id);

const cards = byId("cards");
const titleFilter = byId("filter-title");
const languageFilter = byId("filter-language");
const listError = byId("list-error");
const lookup = byId("lookup");
const lookupQuery = byId("lookup-query");
const lookupStatus = byId("lookup-status");
const lookupError = byId("lookup-error");
const lookupResults = byId("lookup-results");
const previous = byId("previous-page");
const next = byId("next-page");

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
const originalTitleLanguages = new Set(["en", "es", "it", "fr"]);
const pendingAdds = new Set();
const pendingRemovals = new Set();
let saved = [];
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

function displayTitle(item) {
  if (originalTitleLanguages.has(item.original_language)) {
    return item.original_title || item.title;
  }
  return item.title || item.original_title;
}

function metadata(item) {
  const kind = item.media_type === "movie" ? "Film" : "TV show";
  const year = /^\d{4}/.exec(item.release_date)?.[0];
  return [kind, year || "Year unknown", languageName(item.original_language)].join(" · ");
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
  const body = element("div", "card-body");
  const details = element("div", "card-actions");
  const title = displayTitle(item);
  const status = element("span", "badge", item.status || "Status unknown");
  if (["Released", "Ended", "Returning Series"].includes(item.status)) {
    status.classList.add("released");
  }

  const remove = element("button", "remove", "Remove");
  remove.type = "button";
  remove.dataset.key = keyFor(item);

  remove.setAttribute("aria-label", "Remove " + title);
  remove.disabled = pendingRemovals.has(keyFor(item));
  remove.addEventListener("click", () => removeTitle(item, remove));
  details.append(status, remove);
  body.append(element("h3", "", title), element("p", "metadata", metadata(item)), details);
  row.append(poster(item, "w342"), body);
  return row;
}

function renderList() {
  if (!loaded) return;
  const query = normalize(titleFilter.value.trim());
  const language = languageFilter.value;
  const items = saved.filter((item) => (
    (!language || languageKey(item) === language) &&
    (!query || [item.title, item.original_title, item.id, item.imdb_id].some((text) => normalize(text).includes(query)))
  ));
  cards.replaceChildren(...items.map(card));

  const count = saved.length + (saved.length === 1 ? " title" : " titles");
  byId("summary").textContent = items.length === saved.length ? count : items.length + " of " + count;
  byId("empty").hidden = items.length > 0;
  byId("empty-title").textContent = saved.length ? "No matching titles" : "Your wishlist is empty";
  byId("empty-detail").textContent = saved.length
    ? "Try a different search or clear the original language filter."
    : "Use Add title to find your first film or TV show.";
  byId("reset-filters").hidden = !saved.length;
}

async function removeTitle(item, button) {
  const key = keyFor(item);
  if (pendingRemovals.has(key)) return;
  pendingRemovals.add(key);
  button.disabled = true;
  displayNotice(listError);
  try {
    await api("/api/wishlist/" + key, { method: "DELETE" });
    saved = saved.filter((other) => keyFor(other) !== key);
    const restoreFocus = !lookup.open && (document.activeElement === button || document.activeElement === document.body);
    const nextButton = button.closest("li").nextElementSibling?.querySelector(".remove");
    const nextKey = nextButton?.dataset.key;
    updateLanguages();
    renderList();
    updateResultButtons();
    if (restoreFocus) {
      const nextRemove = [...cards.querySelectorAll(".remove")].find((node) => node.dataset.key === nextKey);
      (nextRemove || cards.querySelector(".remove") || byId("open-lookup")).focus();
    }
    byId("feedback").textContent = "Removed " + displayTitle(item) + ".";
  } catch (error) {
    displayNotice(listError, error.message);
  } finally {
    pendingRemovals.delete(key);
    const currentButton = [...cards.querySelectorAll(".remove")].find((node) => node.dataset.key === key);
    if (currentButton) currentButton.disabled = false;
    button.disabled = false;
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

async function addTitle(item) {
  const key = keyFor(item);
  if (isSaved(item) || pendingAdds.has(key)) return;
  pendingAdds.add(key);
  updateResultButtons();
  displayNotice(lookupError);
  try {
    const added = await api("/api/wishlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, media_type: item.media_type }),
    });
    if (!isSaved(added)) saved.unshift(added);
    loaded = true;
    displayNotice(listError);
    updateLanguages();
    renderList();
    (lookup.open ? lookupStatus : byId("feedback")).textContent = "Added " + displayTitle(added) + ".";
  } catch (error) {
    displayNotice(lookup.open ? lookupError : listError, error.message);
  } finally {
    pendingAdds.delete(key);
    updateResultButtons();
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
  button.addEventListener("click", () => addTitle(item));
  body.append(element("strong", "", title), element("p", "metadata", metadata(item)));
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

byId("open-lookup").addEventListener("click", () => lookup.showModal());
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
byId("reset-filters").addEventListener("click", () => {
  titleFilter.value = "";
  languageFilter.value = "";
  renderList();
  titleFilter.focus();
});

async function loadWishlist() {
  try {
    saved = await api("/api/wishlist");
    loaded = true;
    updateLanguages();
    renderList();
    updateResultButtons();
  } catch (error) {
    byId("summary").textContent = "Wishlist unavailable";
    displayNotice(listError, error.message);
  } finally {
    byId("open-lookup").disabled = false;
  }
}

loadWishlist();
