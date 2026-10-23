import {
  articleHref,
  attributeIsSafe,
  elementIsAllowed,
  normalizeHistory,
  normalizeRoute,
  normalizeSearchResults,
  rewriteWikiHref,
} from "./wiki-core.js";

const API = "/api/wiki";
const MEDIAWIKI_BASE = `${location.origin}/wiki/index.php`;
const state = { auth: { authenticated: false, canEdit: false, canCreate: false, oauthEnabled: false }, route: null };

const content = document.getElementById("wiki-content");
const workspace = document.querySelector(".wiki-workspace");
const toolbar = document.getElementById("wiki-toolbar");
const breadcrumb = document.getElementById("wiki-breadcrumb");
const context = document.getElementById("wiki-context");
const editButton = document.getElementById("wiki-edit-button");
const historyButton = document.getElementById("wiki-history-button");
const notice = document.getElementById("wiki-notice");
const authButton = document.getElementById("wiki-auth-button");
const sessionLabel = document.getElementById("wiki-session-label");

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || "No fue posible completar la solicitud.");
    this.status = status;
    this.code = payload?.error?.code || "request_failed";
    this.requestId = payload?.error?.requestId || null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
    ...options,
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child) node.append(child);
  return node;
}

function loading() {
  workspace.setAttribute("aria-busy", "true");
  toolbar.hidden = true;
  context.hidden = true;
  content.replaceChildren(element("div", { class: "wiki-loading", "aria-label": "Cargando contenido" }, [
    element("span"), element("span"), element("span"), element("span"),
  ]));
}

function setNotice(message, kind = "info") {
  notice.hidden = !message;
  notice.dataset.kind = kind;
  notice.textContent = message || "";
}

function finish() {
  workspace.setAttribute("aria-busy", "false");
  markCurrentRail();
}

function sanitizeFragment(html, { diff = false } = {}) {
  const source = diff ? `<table><tbody>${html}</tbody></table>` : `<div>${html}</div>`;
  const parsed = new DOMParser().parseFromString(source, "text/html");
  parsed.querySelectorAll("*").forEach((node) => {
    if (!elementIsAllowed(node.localName) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      node.remove();
      return;
    }
    for (const attribute of [...node.attributes]) {
      if (!attributeIsSafe(attribute.name, attribute.value)) node.removeAttribute(attribute.name);
    }
    if (node instanceof HTMLAnchorElement && node.hasAttribute("href")) {
      const rewritten = rewriteWikiHref(node.getAttribute("href"), MEDIAWIKI_BASE);
      if (!rewritten) node.removeAttribute("href");
      else {
        node.setAttribute("href", rewritten);
        if (rewritten.startsWith("wiki.html?")) node.dataset.wikiNav = "";
        else if (/^https?:\/\//.test(rewritten) && new URL(rewritten).origin !== location.origin) {
          node.target = "_blank";
          node.rel = "noopener noreferrer";
        }
      }
    }
    if (node instanceof HTMLImageElement) {
      node.loading = "lazy";
      node.decoding = "async";
    }
  });
  const root = diff ? parsed.querySelector("table") : parsed.body.firstElementChild;
  const fragment = document.createDocumentFragment();
  while (root?.firstChild) fragment.append(root.firstChild);
  return fragment;
}

function routeUrl(route) {
  if (route.view === "home") return "wiki.html";
  if (route.view === "article") return articleHref(route.title);
  const params = new URLSearchParams({ view: route.view });
  if (route.title) params.set("article", route.title);
  if (route.category) params.set("category", route.category);
  if (route.from) params.set("from", route.from);
  if (route.to) params.set("to", route.to);
  return `wiki.html?${params}`;
}

function navigate(route, { replace = false } = {}) {
  const url = typeof route === "string" ? route : routeUrl(route);
  history[replace ? "replaceState" : "pushState"]({}, "", url);
  renderRoute();
}

function setToolbar(title, { canEdit = false, history = false } = {}) {
  toolbar.hidden = false;
  breadcrumb.replaceChildren(element("span", { text: "Wiki / " }), element("strong", { text: title }));
  editButton.hidden = !(canEdit && state.auth.canEdit);
  historyButton.hidden = !history;
  editButton.onclick = () => navigate({ view: "edit", title });
  historyButton.onclick = () => navigate({ view: "history", title });
}

function categoryHref(category) {
  return routeUrl({ view: "category", category });
}

function renderArticle(article, { home = false } = {}) {
  setToolbar(article.title, { canEdit: true, history: true });
  const header = element("header", { class: "wiki-article-header" }, [
    element("h1", { text: article.title }),
    element("p", { text: article.revisionId ? `Revisión ${article.revisionId}` : "Artículo de la comunidad" }),
  ]);
  const prose = element("div", { class: "wiki-prose" });
  prose.append(sanitizeFragment(article.html));
  const categories = element("div", { class: "wiki-category-list", "aria-label": "Categorías" });
  for (const category of article.categories || []) {
    categories.append(element("a", { href: categoryHref(category), "data-wiki-nav": "", text: category }));
  }
  content.replaceChildren(element("article", { class: "wiki-article" }, [header, prose, categories]));
  renderContext(article.related || [], home ? "También puedes empezar por" : "Páginas relacionadas");
}

function renderContext(titles, heading) {
  context.replaceChildren();
  if (!titles.length) { context.hidden = true; return; }
  context.append(element("h2", { text: heading }));
  const list = element("ul");
  for (const title of titles.slice(0, 10)) list.append(element("li", {}, element("a", { href: articleHref(title), "data-wiki-nav": "", text: title })));
  context.append(list);
  context.hidden = false;
}

function resultItem(item, metadata = null) {
  const link = element("a", { href: articleHref(item.title), "data-wiki-nav": "", text: item.title });
  const node = element("article", { class: "wiki-result" }, [link]);
  if (item.snippet) {
    const summary = element("p");
    summary.append(sanitizeFragment(item.snippet));
    node.append(summary);
  }
  if (metadata) node.append(element("p", { text: metadata }));
  return node;
}

function indexShell(title, description) {
  const root = element("div", { class: "wiki-index" });
  root.append(element("h1", { class: "wiki-view-title", text: title }));
  if (description) root.append(element("p", { class: "wiki-index-intro", text: description }));
  return root;
}

async function renderHome() {
  const data = await api("/home");
  setToolbar("Inicio");
  const root = indexShell("La wiki de ChurrOS", "Guías prácticas escritas y revisadas por la comunidad. MediaWiki conserva cada cambio y ChurrOS te ofrece una lectura clara.");
  const intro = element("section", { class: "wiki-list-section" });
  const prose = element("div", { class: "wiki-prose" });
  prose.append(sanitizeFragment(data.article.html));
  intro.append(prose);
  root.append(intro);

  const featured = element("section", { class: "wiki-list-section" }, element("h2", { text: "Artículos destacados" }));
  const featuredList = element("div", { class: "wiki-link-list" });
  for (const item of data.featured || []) featuredList.append(element("a", { href: articleHref(item.title), "data-wiki-nav": "", text: item.title }));
  featured.append(featuredList.children.length ? featuredList : element("p", { text: "Aún no hay artículos en la categoría Destacados." }));
  root.append(featured);

  const recent = element("section", { class: "wiki-list-section" }, element("h2", { text: "Cambios recientes" }));
  const recentList = element("div", { class: "wiki-link-list" });
  for (const item of data.recent || []) {
    recentList.append(element("a", { href: articleHref(item.title), "data-wiki-nav": "" }, [
      document.createTextNode(item.title), element("small", { text: formatDate(item.timestamp) }),
    ]));
  }
  recent.append(recentList.children.length ? recentList : element("p", { text: "Todavía no hay cambios recientes." }));
  root.append(recent);

  const categories = element("section", { class: "wiki-list-section" }, element("h2", { text: "Explorar categorías" }));
  const categoryList = element("div", { class: "wiki-category-list" });
  for (const item of data.categories || []) {
    const name = item["*"] || item.category || item.title;
    if (name) categoryList.append(element("a", { href: categoryHref(name), "data-wiki-nav": "", text: name }));
  }
  categories.append(categoryList.children.length ? categoryList : element("p", { text: "Aún no hay categorías." }));
  root.append(categories);
  content.replaceChildren(root);
  renderContext((data.featured || []).map((item) => item.title), "Lecturas recomendadas");
}

async function renderSearch(query) {
  loading();
  const data = normalizeSearchResults(await api(`/search?q=${encodeURIComponent(query)}&limit=20`));
  setToolbar(`Resultados para “${query}”`);
  const root = indexShell(`Resultados para “${query}”`, `${data.length} ${data.length === 1 ? "resultado" : "resultados"}`);
  const list = element("div", { class: "wiki-result-list" });
  for (const item of data) list.append(resultItem(item));
  if (!data.length) root.append(emptyState("No encontramos coincidencias", "Prueba con menos palabras o crea el artículo si tienes permiso.", query));
  else root.append(list);
  content.replaceChildren(root);
  context.hidden = true;
  finish();
}

async function renderCategory(category) {
  const data = await api(`/categories?category=${encodeURIComponent(category)}&limit=50`);
  setToolbar(category);
  const members = data.members || [];
  const root = indexShell(category, `${members.length} ${members.length === 1 ? "artículo" : "artículos"} en esta categoría.`);
  const list = element("div", { class: "wiki-link-list" });
  for (const item of members) list.append(element("a", { href: articleHref(item.title), "data-wiki-nav": "" }, [
    document.createTextNode(item.title), element("small", { text: formatDate(item.timestamp) }),
  ]));
  root.append(members.length ? list : emptyState("Categoría vacía", "Todavía no hay artículos en esta categoría."));
  content.replaceChildren(root);
}

async function renderCategories() {
  const data = await api("/categories?limit=50");
  setToolbar("Categorías");
  const root = indexShell("Categorías", "Explora la documentación por tema.");
  const list = element("div", { class: "wiki-link-list" });
  for (const item of data.categories || []) {
    const name = item["*"] || item.category;
    if (!name) continue;
    list.append(element("a", { href: categoryHref(name), "data-wiki-nav": "" }, [
      document.createTextNode(name), element("small", { text: `${Number(item.pages) || 0} páginas` }),
    ]));
  }
  root.append(list.children.length ? list : emptyState("Sin categorías", "Las categorías aparecerán cuando los artículos las usen."));
  content.replaceChildren(root);
}

async function renderRecent() {
  const changes = await api("/recent?limit=25");
  setToolbar("Cambios recientes");
  const root = indexShell("Cambios recientes", "Las últimas ediciones registradas por MediaWiki.");
  const list = element("div", { class: "wiki-result-list" });
  for (const change of changes) list.append(resultItem(change, `${change.user || "Usuario oculto"} · ${formatDate(change.timestamp)}${change.comment ? ` · ${change.comment}` : ""}`));
  root.append(changes.length ? list : emptyState("Sin cambios recientes", "Las ediciones aparecerán aquí."));
  content.replaceChildren(root);
}

async function renderHistory(title) {
  const data = normalizeHistory(await api(`/history?title=${encodeURIComponent(title)}&limit=50`));
  setToolbar(`Historial de ${data.title}`, { canEdit: true });
  const root = indexShell(`Historial de ${data.title}`, "Cada edición se conserva. Compara una revisión con la anterior para ver qué cambió.");
  const list = element("div", { class: "wiki-history-list" });
  for (const revision of data.revisions) {
    const actions = [];
    if (revision.parentRevisionId) actions.push(element("a", {
      href: routeUrl({ view: "diff", title: data.title, from: revision.parentRevisionId, to: revision.revisionId }),
      "data-wiki-nav": "", text: "Ver cambios",
    }));
    list.append(element("article", { class: "wiki-result" }, [
      element("strong", { text: formatDate(revision.timestamp) }),
      element("p", { text: `${revision.user} · ${revision.comment} · ${revision.size} bytes${revision.minor ? " · edición menor" : ""}` }),
      ...actions,
    ]));
  }
  root.append(data.revisions.length ? list : emptyState("Sin revisiones", "Este artículo todavía no tiene historial."));
  content.replaceChildren(root);
}

async function renderDiff(route) {
  const data = await api(`/diff?from=${route.from}&to=${route.to}`);
  setToolbar(`Cambios en ${route.title}`, { history: true });
  historyButton.onclick = () => navigate({ view: "history", title: route.title });
  const root = indexShell("Comparación de revisiones", `Cambios entre las revisiones ${data.fromRevisionId} y ${data.toRevisionId}.`);
  const wrapper = element("div", { class: "wiki-prose" });
  const table = element("table", { class: "wiki-diff" });
  table.append(sanitizeFragment(data.html, { diff: true }));
  wrapper.append(table);
  root.append(wrapper);
  content.replaceChildren(root);
}

async function renderEditor(title) {
  if (!state.auth.authenticated || !state.auth.canEdit) {
    throw new ApiError(403, { error: { code: "forbidden", message: "Tu cuenta de MediaWiki no tiene permiso para editar." } });
  }
  const source = await api(`/source?title=${encodeURIComponent(title)}`);
  if (source.missing && !state.auth.canCreate) throw new ApiError(403, { error: { message: "Tu cuenta no puede crear artículos." } });
  setToolbar(source.missing ? `Crear ${title}` : `Editar ${source.title}`);
  const form = element("form", { class: "wiki-editor" });
  form.append(element("h1", { class: "wiki-view-title", text: source.missing ? `Crear ${title}` : `Editar ${source.title}` }));
  form.append(element("label", { for: "wiki-source", text: "Contenido en wikitext" }));
  const textarea = element("textarea", { id: "wiki-source", name: "text", required: "", spellcheck: "true" });
  textarea.value = source.text || "";
  form.append(textarea);
  form.append(element("label", { for: "wiki-summary", text: "Resumen de la edición" }));
  const summary = element("input", { id: "wiki-summary", name: "summary", maxlength: "500", placeholder: "Describe brevemente qué cambió" });
  const save = element("button", { type: "submit", text: source.missing ? "Crear artículo" : "Guardar cambios" });
  form.append(summary, element("div", { class: "wiki-editor-footer" }, [
    element("p", { text: "El formato y el historial los gestiona MediaWiki." }), save,
  ]));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    save.textContent = "Guardando…";
    setNotice("");
    try {
      await api("/article", {
        method: "POST",
        body: JSON.stringify({ title: source.title || title, text: textarea.value, summary: summary.value, baseRevisionId: source.revisionId }),
      });
      sessionStorage.setItem("wiki-confirmation", source.missing ? "Artículo creado." : "Cambios guardados.");
      navigate({ view: "article", title: source.title || title });
    } catch (error) {
      setNotice(error.message, "error");
      save.disabled = false;
      save.textContent = source.missing ? "Crear artículo" : "Guardar cambios";
    }
  });
  content.replaceChildren(form);
}

function emptyState(title, message, suggestedTitle = null) {
  const root = element("div", { class: "wiki-empty" }, [element("h2", { text: title }), element("p", { text: message })]);
  if (suggestedTitle && state.auth.canCreate) root.append(element("button", {
    class: "wiki-primary-action", type: "button", text: "Crear artículo", onclick: () => navigate({ view: "edit", title: suggestedTitle }),
  }));
  return root;
}

function renderError(error, route) {
  setToolbar("No pudimos abrir esta vista");
  const isMissing = error.status === 404 && route?.title;
  const root = element("div", { class: "wiki-error" }, [
    element("h2", { text: isMissing ? "Este artículo todavía no existe" : "La wiki no respondió" }),
    element("p", { text: isMissing ? "Puedes buscar otro tema o crear esta página si tienes permiso." : error.message }),
  ]);
  if (isMissing && state.auth.canCreate) root.append(element("button", {
    class: "wiki-primary-action", type: "button", text: "Crear artículo", onclick: () => navigate({ view: "edit", title: route.title }),
  }));
  if (!isMissing) root.append(element("button", { type: "button", text: "Intentar de nuevo", onclick: () => renderRoute() }));
  content.replaceChildren(root);
  context.hidden = true;
}

function formatDate(value) {
  if (!value) return "Fecha no disponible";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Fecha no disponible" : new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function markCurrentRail() {
  document.querySelectorAll(".wiki-rail [data-view]").forEach((item) => {
    const active = item.dataset.view === state.route?.view;
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
}

async function renderRoute() {
  setNotice("");
  loading();
  const route = normalizeRoute(location.search);
  state.route = route;
  try {
    if (route.view === "home") await renderHome();
    else if (route.view === "article") renderArticle(await api(`/article?title=${encodeURIComponent(route.title)}`));
    else if (route.view === "categories") await renderCategories();
    else if (route.view === "category") await renderCategory(route.category);
    else if (route.view === "recent") await renderRecent();
    else if (route.view === "history") await renderHistory(route.title);
    else if (route.view === "diff") await renderDiff(route);
    else if (route.view === "edit") await renderEditor(route.title);
    const confirmation = sessionStorage.getItem("wiki-confirmation");
    if (confirmation) { sessionStorage.removeItem("wiki-confirmation"); setNotice(confirmation); }
    document.title = `${route.title || route.category || "Wiki"} — ChurrOS`;
  } catch (error) {
    renderError(error, route);
  } finally {
    finish();
  }
}

async function loadAuth() {
  try { state.auth = await api("/auth/status"); } catch { state.auth = { authenticated: false, canEdit: false, canCreate: false, oauthEnabled: false }; }
  if (state.auth.authenticated) {
    sessionLabel.textContent = `Sesión: ${state.auth.name}`;
    authButton.hidden = false;
    authButton.textContent = "Cerrar sesión";
    authButton.onclick = async () => { await api("/auth/logout", { method: "POST" }); location.reload(); };
  } else {
    sessionLabel.textContent = state.auth.oauthEnabled ? "Lectura pública" : "Edición no configurada";
    authButton.hidden = !state.auth.oauthEnabled;
    authButton.textContent = "Iniciar sesión";
    authButton.onclick = () => { location.href = `${API}/auth/login`; };
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-wiki-nav]");
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || !url.pathname.endsWith("/wiki.html")) return;
  event.preventDefault();
  navigate(url.pathname.split("/").pop() + url.search + url.hash);
});

document.getElementById("wiki-search").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = document.getElementById("wiki-search-input").value.trim();
  if (query.length >= 2) renderSearch(query);
});
document.getElementById("wiki-categories-button").addEventListener("click", () => navigate({ view: "categories" }));
window.addEventListener("popstate", renderRoute);

await loadAuth();
await renderRoute();
