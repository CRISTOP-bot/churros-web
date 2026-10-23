import assert from "node:assert/strict";
import test from "node:test";

import { MediaWikiClient, MediaWikiError } from "../server/mediawiki-client.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

test("GET requests include stable MediaWiki response parameters", async () => {
  let request;
  const client = new MediaWikiClient({
    apiUrl: "http://wiki.internal/w/api.php",
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return jsonResponse({ query: { ok: true } });
    },
  });

  await client.request({ action: "query", titles: "Inicio" });

  assert.equal(request.url.origin + request.url.pathname, "http://wiki.internal/w/api.php");
  assert.equal(request.url.searchParams.get("action"), "query");
  assert.equal(request.url.searchParams.get("titles"), "Inicio");
  assert.equal(request.url.searchParams.get("format"), "json");
  assert.equal(request.url.searchParams.get("formatversion"), "2");
  assert.equal(request.options.headers["user-agent"], "ChurrOS-Wiki/1.0");
});

test("POST requests keep OAuth tokens in headers and encode action fields in the body", async () => {
  let request;
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ edit: { result: "Success" } });
    },
  });

  await client.request(
    { action: "edit", title: "Guía", text: "Contenido", token: "csrf" },
    { method: "POST", accessToken: "private-token" },
  );

  assert.equal(request.url, "https://wiki.example/w/api.php");
  assert.equal(request.options.headers.authorization, "Bearer private-token");
  assert.match(request.options.headers["content-type"], /application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get("action"), "edit");
  assert.equal(body.get("text"), "Contenido");
  assert.equal(body.get("formatversion"), "2");
});

test("invalid JSON is reported as a stable upstream error", async () => {
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    fetchImpl: async () => new Response("not-json", { headers: { "content-type": "text/html" } }),
  });

  await assert.rejects(
    client.request({ action: "query" }),
    (error) => error instanceof MediaWikiError && error.code === "invalid_upstream_response",
  );
});

test("timeouts are distinguished from other network failures", async () => {
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });

  await assert.rejects(
    client.request({ action: "query" }),
    (error) => error instanceof MediaWikiError && error.code === "upstream_timeout",
  );
});

test("timeout covers delayed response bodies", async () => {
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"query":{"ok":true}}'));
          controller.close();
        }, 30);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          controller.error(signal.reason);
        }, { once: true });
      },
    }), { headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    client.request({ action: "query" }),
    (error) => error instanceof MediaWikiError && error.code === "upstream_timeout",
  );
});

test("modern MediaWiki API errors are normalized", async () => {
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    fetchImpl: async () => jsonResponse({ errors: [{ code: "editconflict", text: "Conflict" }] }),
  });

  await assert.rejects(
    client.request({ action: "edit" }),
    (error) => error instanceof MediaWikiError && error.code === "editconflict" && error.message === "Conflict",
  );
});

test("oversized MediaWiki responses are rejected", async () => {
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    maxResponseBytes: 16,
    fetchImpl: async () => jsonResponse({ query: { value: "x".repeat(100) } }),
  });

  await assert.rejects(
    client.request({ action: "query" }),
    (error) => error instanceof MediaWikiError && error.code === "upstream_response_too_large",
  );
});

test("MediaWiki API errors preserve only safe error metadata", async () => {
  const client = new MediaWikiClient({
    apiUrl: "https://wiki.example/w/api.php",
    fetchImpl: async () => jsonResponse({ error: { code: "permissiondenied", info: "Denied", secret: "x" } }),
  });

  await assert.rejects(
    client.request({ action: "edit" }),
    (error) => error instanceof MediaWikiError
      && error.code === "permissiondenied"
      && error.message === "Denied"
      && !JSON.stringify(error.details).includes("secret"),
  );
});
