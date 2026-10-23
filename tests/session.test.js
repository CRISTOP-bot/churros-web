import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, publicConfig } from "../server/config.js";
import { SessionCodec, parseCookies, serializeCookie } from "../server/session.js";

const secret = "0123456789abcdef0123456789abcdef";

test("configuration validates URLs and exposes no secrets in its public projection", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PORT: "3000",
    PUBLIC_ORIGIN: "https://www.churroslinux.org",
    WIKI_API_URL: "http://127.0.0.1:8081/w/api.php",
    WIKI_OAUTH_BASE_URL: "http://127.0.0.1:8081/w/rest.php/oauth2",
    WIKI_OAUTH_CLIENT_ID: "churros",
    WIKI_OAUTH_CLIENT_SECRET: "oauth-private",
    WIKI_OAUTH_REDIRECT_URI: "https://www.churroslinux.org/api/wiki/auth/callback",
    SESSION_SECRET: secret,
  });

  assert.equal(config.port, 3000);
  assert.equal(config.oauth.enabled, true);
  const visible = JSON.stringify(publicConfig(config));
  assert.doesNotMatch(visible, /oauth-private|0123456789abcdef/);
  assert.match(visible, /wikiConfigured/);
});

test("configuration rejects short session secrets", () => {
  assert.throws(() => loadConfig({
    PUBLIC_ORIGIN: "https://www.churroslinux.org",
    WIKI_API_URL: "http://127.0.0.1/w/api.php",
    SESSION_SECRET: "short",
  }), /SESSION_SECRET/);
});

test("sealed sessions round-trip and reject tampering", () => {
  const codec = new SessionCodec({ secret, now: () => 1_000, ttlMs: 10_000 });
  const sealed = codec.seal({ accessToken: "private", user: { name: "Lina" } });

  assert.deepEqual(codec.open(sealed), { accessToken: "private", user: { name: "Lina" } });
  const replacement = sealed.endsWith("a") ? "b" : "a";
  assert.equal(codec.open(sealed.slice(0, -1) + replacement), null);
});

test("expired sessions fail closed", () => {
  let now = 1_000;
  const codec = new SessionCodec({ secret, now: () => now, ttlMs: 100 });
  const sealed = codec.seal({ accessToken: "private" });
  now = 1_101;
  assert.equal(codec.open(sealed), null);
});

test("cookie utilities preserve encoded values and security attributes", () => {
  assert.deepEqual(parseCookies("first=one; churros_wiki=hello%20world"), {
    first: "one",
    churros_wiki: "hello world",
  });
  const cookie = serializeCookie("churros_wiki", "opaque", { secure: true, maxAge: 60 });
  assert.match(cookie, /^churros_wiki=opaque;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=60/);
});
