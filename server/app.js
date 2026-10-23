import { randomUUID } from "node:crypto";

import { publicConfig } from "./config.js";
import { HttpError, RateLimiter, assertSameOrigin, readJson } from "./security.js";
import { parseCookies, serializeCookie } from "./session.js";

const SESSION_COOKIE = "churros_wiki_session";
const OAUTH_COOKIE = "churros_wiki_oauth";

function sendJson(response, status, body, { requestId, cache = "no-store", headers = {} } = {}) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": cache,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...(requestId ? { "x-request-id": requestId } : {}),
    ...headers,
  });
  response.end(data);
}

function sendRedirect(response, location, cookies = []) {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  response.end();
}

function queryString(url, name, { required = true, min = 1, max = 160, code = "invalid_query" } = {}) {
  const values = url.searchParams.getAll(name);
  const value = values[0]?.trim() || "";
  if (values.length > 1 || (required && !value) || value.length < (required ? min : 0) || value.length > max) {
    throw new HttpError(400, code, `El parámetro ${name} no es válido.`);
  }
  return value || null;
}

function queryInteger(url, name, { fallback, min = 1, max = 50, required = false } = {}) {
  const raw = url.searchParams.get(name);
  if (raw === null && !required) return fallback;
  if (!/^\d+$/.test(raw || "")) throw new HttpError(400, "invalid_query", `El parámetro ${name} no es válido.`);
  const value = Number(raw);
  if (value < min || value > max) throw new HttpError(400, "invalid_query", `El parámetro ${name} no es válido.`);
  return value;
}

function validatedArticle(body) {
  const title = String(body.title ?? "").trim().replace(/\s+/g, " ");
  const text = String(body.text ?? "");
  const summary = String(body.summary ?? "").trim();
  if (!title || title.length > 160 || /[\[\]{}<>|]/.test(title)) {
    throw new HttpError(400, "invalid_title", "El título no es válido.");
  }
  if (Buffer.byteLength(text) > 200_000) throw new HttpError(400, "article_too_large", "El artículo supera el límite permitido.");
  if (summary.length > 500) throw new HttpError(400, "summary_too_large", "El resumen supera el límite permitido.");
  const baseRevisionId = body.baseRevisionId === undefined || body.baseRevisionId === null
    ? null
    : Number(body.baseRevisionId);
  if (baseRevisionId !== null && (!Number.isInteger(baseRevisionId) || baseRevisionId < 1)) {
    throw new HttpError(400, "invalid_revision", "La revisión base no es válida.");
  }
  return { title, text, summary, baseRevisionId };
}

function errorStatus(error) {
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  if (String(error?.code || "").startsWith("upstream_")) return 502;
  return 500;
}

function publicError(error, requestId) {
  const status = errorStatus(error);
  const expose = status < 500;
  return {
    status,
    body: {
      error: {
        code: expose ? String(error.code || "request_failed") : String(error.code || "upstream_failure"),
        message: expose ? error.message : "El servicio de wiki no está disponible en este momento.",
        requestId,
      },
    },
  };
}

export function createApp({ config, service, oauth, sessionCodec, logger = console }) {
  const readLimiter = new RateLimiter({ limit: config.rateLimit.read, windowMs: config.rateLimit.windowMs });
  const writeLimiter = new RateLimiter({ limit: config.rateLimit.write, windowMs: config.rateLimit.windowMs });
  const secureCookie = Boolean(config.session.secure);
  const readCache = "public, max-age=30, stale-while-revalidate=120";

  async function accessSession(request) {
    const cookies = parseCookies(request.headers.cookie);
    let session = sessionCodec.open(cookies[SESSION_COOKIE]);
    if (!session?.accessToken) return { session: null, cookie: null };
    if (session.expiresAt && session.expiresAt <= Date.now() + 30_000) {
      if (!session.refreshToken || !oauth?.refresh) return { session: null, cookie: null };
      const refreshed = await oauth.refresh(session.refreshToken);
      session = {
        ...session,
        ...refreshed,
        refreshToken: refreshed.refreshToken || session.refreshToken,
      };
      return {
        session,
        cookie: serializeCookie(SESSION_COOKIE, sessionCodec.seal(session), {
          secure: secureCookie,
          maxAge: Math.floor(config.session.ttlMs / 1_000),
        }),
      };
    }
    return { session, cookie: null };
  }

  return async function app(request, response) {
    const requestId = randomUUID();
    const url = new URL(request.url, config.publicOrigin);
    const clientKey = request.socket?.remoteAddress || "unknown";
    const limiter = request.method === "POST" ? writeLimiter : readLimiter;
    const limit = limiter.consume(clientKey);
    if (!limit.allowed) {
      sendJson(response, 429, { error: { code: "rate_limited", message: "Demasiadas solicitudes. Intenta de nuevo en un momento.", requestId } }, {
        requestId,
        headers: { "retry-after": String(limit.retryAfter) },
      });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/wiki/health") {
        const visible = publicConfig(config);
        sendJson(response, 200, { status: "ok", wikiConfigured: visible.wikiConfigured, oauthEnabled: visible.oauthEnabled }, { requestId });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/wiki/home") {
        sendJson(response, 200, await service.getHome(), { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/search") {
        const query = queryString(url, "q", { min: 2, max: 200 });
        const limitValue = queryInteger(url, "limit", { fallback: 10, max: 20 });
        sendJson(response, 200, { results: await service.search(query, limitValue) }, { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/article") {
        const title = queryString(url, "title");
        sendJson(response, 200, await service.getArticle(title), { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/source") {
        const title = queryString(url, "title");
        sendJson(response, 200, await service.getSource(title), { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/categories") {
        const category = queryString(url, "category", { required: false });
        const limitValue = queryInteger(url, "limit", { fallback: 20, max: 50 });
        sendJson(response, 200, await service.getCategories(category, limitValue), { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/recent") {
        const limitValue = queryInteger(url, "limit", { fallback: 10, max: 25 });
        sendJson(response, 200, await service.getRecent(limitValue), { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/history") {
        const title = queryString(url, "title");
        const limitValue = queryInteger(url, "limit", { fallback: 20, max: 50 });
        sendJson(response, 200, await service.getHistory(title, limitValue), { requestId, cache: readCache });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/diff") {
        const from = queryInteger(url, "from", { required: true, max: Number.MAX_SAFE_INTEGER });
        const to = queryInteger(url, "to", { required: true, max: Number.MAX_SAFE_INTEGER });
        sendJson(response, 200, await service.getDiff(from, to), { requestId, cache: readCache });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/wiki/auth/login") {
        if (!config.oauth.enabled || !oauth) throw new HttpError(503, "oauth_unavailable", "La edición todavía no está configurada.");
        const attempt = oauth.createAuthorization();
        const state = sessionCodec.seal({ state: attempt.state, verifier: attempt.verifier }, 600_000);
        sendRedirect(response, attempt.url, [serializeCookie(OAUTH_COOKIE, state, {
          secure: secureCookie, maxAge: 600, path: "/api/wiki/auth",
        })]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/auth/callback") {
        if (!config.oauth.enabled || !oauth) throw new HttpError(503, "oauth_unavailable", "La edición todavía no está configurada.");
        const cookies = parseCookies(request.headers.cookie);
        const attempt = sessionCodec.open(cookies[OAUTH_COOKIE]);
        if (!attempt) throw new HttpError(400, "oauth_session_expired", "La solicitud de acceso expiró.");
        const code = queryString(url, "code", { max: 2_048 });
        const state = queryString(url, "state", { max: 512 });
        const session = await oauth.exchangeCode({ code, state, expectedState: attempt.state, verifier: attempt.verifier });
        const sealedSession = sessionCodec.seal(session);
        sendRedirect(response, "/wiki.html?auth=success", [
          serializeCookie(SESSION_COOKIE, sealedSession, { secure: secureCookie, maxAge: Math.floor(config.session.ttlMs / 1_000) }),
          serializeCookie(OAUTH_COOKIE, "", { secure: secureCookie, maxAge: 0, path: "/api/wiki/auth" }),
        ]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/wiki/auth/status") {
        const loaded = await accessSession(request);
        const { session } = loaded;
        if (!session?.accessToken) {
          sendJson(response, 200, { authenticated: false, name: null, canEdit: false, canCreate: false, oauthEnabled: config.oauth.enabled }, { requestId });
          return;
        }
        const permissions = await service.getPermissions(session.accessToken);
        sendJson(response, 200, { ...permissions, oauthEnabled: config.oauth.enabled }, {
          requestId,
          headers: loaded.cookie ? { "set-cookie": loaded.cookie } : {},
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/wiki/auth/logout") {
        assertSameOrigin(request, config.publicOrigin);
        sendJson(response, 200, { loggedOut: true }, {
          requestId,
          headers: { "set-cookie": serializeCookie(SESSION_COOKIE, "", { secure: secureCookie, maxAge: 0 }) },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/wiki/article") {
        assertSameOrigin(request, config.publicOrigin);
        const loaded = await accessSession(request);
        const { session } = loaded;
        if (!session?.accessToken) throw new HttpError(401, "authentication_required", "Inicia sesión con MediaWiki para editar.");
        const body = validatedArticle(await readJson(request, { maxBytes: 210_000 }));
        sendJson(response, 200, await service.saveArticle(body, session.accessToken), {
          requestId,
          headers: loaded.cookie ? { "set-cookie": loaded.cookie } : {},
        });
        return;
      }

      throw new HttpError(404, "not_found", "La ruta de wiki no existe.");
    } catch (error) {
      const { status, body } = publicError(error, requestId);
      if (status >= 500) logger.error?.("wiki request failed", { requestId, code: error?.code || error?.name || "unknown" });
      sendJson(response, status, body, { requestId });
    }
  };
}
