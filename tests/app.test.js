import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createApp } from "../server/app.js";
import { SessionCodec } from "../server/session.js";
import { WikiServiceError } from "../server/wiki-service.js";

const sessionSecret = "0123456789abcdef0123456789abcdef";

function makeConfig(overrides = {}) {
  return {
    environment: "test",
    publicOrigin: "https://www.churroslinux.org",
    wiki: { apiUrl: "http://127.0.0.1:8081/w/api.php", mainPage: "Página principal" },
    oauth: { enabled: true },
    session: { secret: sessionSecret, ttlMs: 60_000, secure: true },
    rateLimit: { read: 100, write: 10, windowMs: 60_000 },
    ...overrides,
  };
}

function fakeService() {
  const calls = [];
  const service = { calls };
  for (const [name, result] of Object.entries({
    getHome: { section: "home" },
    search: [{ title: "Resultado" }],
    getArticle: { title: "Guía" },
    getSource: { title: "Guía", text: "Texto", revisionId: 2 },
    getCategories: { categories: [] },
    getRecent: [{ title: "Reciente" }],
    getHistory: { title: "Guía", revisions: [] },
    getDiff: { fromRevisionId: 1, toRevisionId: 2, html: "<tr></tr>" },
    getPermissions: { authenticated: true, name: "Lina", canEdit: true, canCreate: true },
    saveArticle: { title: "Guía", revisionId: 3 },
  })) {
    service[name] = async (...args) => { calls.push({ name, args }); return structuredClone(result); };
  }
  return service;
}

async function withApp(run, options = {}) {
  const service = options.service || fakeService();
  const oauth = options.oauth || {
    createAuthorization: () => ({ url: "https://wiki.example/oauth2/authorize?state=state", state: "state", verifier: "verifier" }),
    exchangeCode: async () => ({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, user: { name: "Lina" } }),
  };
  const sessionCodec = new SessionCodec({ secret: sessionSecret, ttlMs: 60_000 });
  const handler = createApp({ config: makeConfig(options.config), service, oauth, sessionCodec, logger: { error() {} } });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, service, sessionCodec });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health is secret-free, non-CORS, and carries a request id", async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/wiki/health`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.ok(response.headers.get("x-request-id"));
    assert.deepEqual(payload, { status: "ok", wikiConfigured: true, oauthEnabled: true });
    assert.doesNotMatch(JSON.stringify(payload), /0123456789abcdef|access|secret/i);
  });
});

test("read routes dispatch validated parameters to the wiki service", async () => {
  const cases = [
    ["/api/wiki/home", "getHome", []],
    ["/api/wiki/search?q=linux&limit=7", "search", ["linux", 7]],
    ["/api/wiki/article?title=Gu%C3%ADa", "getArticle", ["Guía"]],
    ["/api/wiki/source?title=Gu%C3%ADa", "getSource", ["Guía"]],
    ["/api/wiki/categories?category=Gu%C3%ADas&limit=9", "getCategories", ["Guías", 9]],
    ["/api/wiki/recent?limit=6", "getRecent", [6]],
    ["/api/wiki/history?title=Gu%C3%ADa&limit=8", "getHistory", ["Guía", 8]],
    ["/api/wiki/diff?from=10&to=11", "getDiff", [10, 11]],
  ];
  await withApp(async ({ baseUrl, service }) => {
    for (const [path, method, args] of cases) {
      const response = await fetch(baseUrl + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "public, max-age=30, stale-while-revalidate=120");
      const call = service.calls.at(-1);
      assert.equal(call.name, method, path);
      assert.deepEqual(call.args, args, path);
    }
  });
});

test("validation errors are bounded and never call MediaWiki", async () => {
  await withApp(async ({ baseUrl, service }) => {
    const response = await fetch(`${baseUrl}/api/wiki/search?q=${"x".repeat(250)}`);
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "invalid_query");
    assert.ok(payload.error.requestId);
    assert.equal(service.calls.length, 0);
  });
});

test("anonymous writes are rejected before MediaWiki is called", async () => {
  await withApp(async ({ baseUrl, service }) => {
    const response = await fetch(`${baseUrl}/api/wiki/article`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.churroslinux.org" },
      body: JSON.stringify({ title: "Guía", text: "Texto", summary: "Cambio", baseRevisionId: 2 }),
    });
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(payload.error.code, "authentication_required");
    assert.equal(service.calls.length, 0);
  });
});

test("authenticated writes pass the server-held access token and validated body", async () => {
  await withApp(async ({ baseUrl, service, sessionCodec }) => {
    const cookie = sessionCodec.seal({ accessToken: "server-private", user: { name: "Lina" } });
    const response = await fetch(`${baseUrl}/api/wiki/article`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://www.churroslinux.org",
        cookie: `churros_wiki_session=${cookie}`,
      },
      body: JSON.stringify({ title: "Guía", text: "Nuevo", summary: "Cambio", baseRevisionId: 2 }),
    });
    assert.equal(response.status, 200);
    const call = service.calls.at(-1);
    assert.equal(call.name, "saveArticle");
    assert.equal(call.args[1], "server-private");
    assert.equal(call.args[0].title, "Guía");
  });
});

test("insufficient MediaWiki rights remain a 403 response", async () => {
  const service = fakeService();
  service.saveArticle = async () => { throw new WikiServiceError("forbidden", "Sin permiso", { status: 403 }); };
  await withApp(async ({ baseUrl, sessionCodec }) => {
    const cookie = sessionCodec.seal({ accessToken: "token" });
    const response = await fetch(`${baseUrl}/api/wiki/article`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.churroslinux.org", cookie: `churros_wiki_session=${cookie}` },
      body: JSON.stringify({ title: "Guía", text: "Nuevo" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "forbidden");
  }, { service });
});

test("unexpected upstream failures become stable 502 errors without details", async () => {
  const service = fakeService();
  service.getArticle = async () => { throw Object.assign(new Error("connect ECONNREFUSED private.internal"), { code: "upstream_unavailable" }); };
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/wiki/article?title=Gu%C3%ADa`);
    const payload = await response.json();
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, "upstream_unavailable");
    assert.doesNotMatch(JSON.stringify(payload), /private\.internal|ECONNREFUSED/);
  }, { service });
});

test("OAuth login and callback use short-lived state and HttpOnly session cookies", async () => {
  await withApp(async ({ baseUrl }) => {
    const login = await fetch(`${baseUrl}/api/wiki/auth/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.match(login.headers.get("location"), /^https:\/\/wiki\.example/);
    const stateCookie = login.headers.get("set-cookie");
    assert.match(stateCookie, /churros_wiki_oauth=/);
    assert.match(stateCookie, /HttpOnly/);

    const callback = await fetch(`${baseUrl}/api/wiki/auth/callback?code=code&state=state`, {
      redirect: "manual",
      headers: { cookie: stateCookie.split(";")[0] },
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/wiki.html?auth=success");
    assert.match(callback.headers.get("set-cookie"), /churros_wiki_session=/);
  });
});

test("auth status exposes permissions but never the OAuth token", async () => {
  await withApp(async ({ baseUrl, sessionCodec }) => {
    const cookie = sessionCodec.seal({ accessToken: "server-private", user: { name: "Lina" } });
    const response = await fetch(`${baseUrl}/api/wiki/auth/status`, { headers: { cookie: `churros_wiki_session=${cookie}` } });
    const body = await response.json();
    assert.equal(body.name, "Lina");
    assert.equal(body.canEdit, true);
    assert.doesNotMatch(JSON.stringify(body), /server-private/);
  });
});

test("auth status refreshes an expired access token without exposing it", async () => {
  const service = fakeService();
  const oauth = {
    createAuthorization() {},
    exchangeCode() {},
    async refresh(token) {
      assert.equal(token, "refresh-private");
      return { accessToken: "new-private", refreshToken: null, expiresAt: Date.now() + 60_000, scope: "basic" };
    },
  };
  await withApp(async ({ baseUrl, sessionCodec }) => {
    const cookie = sessionCodec.seal({
      accessToken: "expired-private",
      refreshToken: "refresh-private",
      expiresAt: Date.now() - 1,
      user: { name: "Lina" },
    });
    const response = await fetch(`${baseUrl}/api/wiki/auth/status`, { headers: { cookie: `churros_wiki_session=${cookie}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /churros_wiki_session=/);
    const permissionCall = service.calls.at(-1);
    assert.equal(permissionCall.name, "getPermissions");
    assert.equal(permissionCall.args[0], "new-private");
    assert.doesNotMatch(JSON.stringify(await response.json()), /private/);
  }, { service, oauth });
});

test("logout requires same origin and clears the session cookie", async () => {
  await withApp(async ({ baseUrl }) => {
    const denied = await fetch(`${baseUrl}/api/wiki/auth/logout`, { method: "POST" });
    assert.equal(denied.status, 403);
    const response = await fetch(`${baseUrl}/api/wiki/auth/logout`, {
      method: "POST", headers: { origin: "https://www.churroslinux.org" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("unknown API paths return the same error envelope", async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/wiki/unknown`);
    const body = await response.json();
    assert.equal(response.status, 404);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
  });
});
