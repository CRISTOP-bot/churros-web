import assert from "node:assert/strict";
import test from "node:test";

import { OAuthClient, OAuthError, pkceChallenge } from "../server/oauth.js";

function response(body, contentType = "application/json") {
  const payload = contentType === "application/json" ? JSON.stringify(body) : String(body);
  return new Response(payload, { status: 200, headers: { "content-type": contentType } });
}

test("PKCE challenge follows RFC 7636", () => {
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("authorization uses code flow, S256 PKCE, state, and the configured scope", () => {
  const oauth = new OAuthClient({
    baseUrl: "https://wiki.example/w/rest.php/oauth2",
    clientId: "client-id",
    redirectUri: "https://site.example/api/wiki/auth/callback",
    scope: "basic editpage",
  });

  const attempt = oauth.createAuthorization();
  const url = new URL(attempt.url);

  assert.equal(url.pathname, "/w/rest.php/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), attempt.state);
  assert.equal(url.searchParams.get("scope"), "basic editpage");
  assert.ok(attempt.verifier.length >= 43);
});

test("callback rejects state mismatch without contacting MediaWiki", async () => {
  let calls = 0;
  const oauth = new OAuthClient({
    baseUrl: "https://wiki.example/oauth2",
    clientId: "id",
    redirectUri: "https://site.example/callback",
    fetchImpl: async () => { calls += 1; return response({}); },
  });

  await assert.rejects(
    oauth.exchangeCode({ code: "code", state: "wrong", expectedState: "right", verifier: "verifier" }),
    (error) => error instanceof OAuthError && error.code === "oauth_state_mismatch",
  );
  assert.equal(calls, 0);
});

test("callback exchanges the code and fetches the profile with a bearer token", async () => {
  const calls = [];
  const oauth = new OAuthClient({
    baseUrl: "https://wiki.example/w/rest.php/oauth2/",
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://site.example/callback",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/access_token")) return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      return response({ sub: 7, username: "Lina" });
    },
  });

  const session = await oauth.exchangeCode({ code: "code", state: "same", expectedState: "same", verifier: "verifier" });

  assert.equal(session.accessToken, "access");
  assert.equal(session.refreshToken, "refresh");
  assert.equal(session.user.name, "Lina");
  const tokenBody = new URLSearchParams(calls[0].options.body);
  assert.equal(tokenBody.get("grant_type"), "authorization_code");
  assert.equal(tokenBody.get("client_secret"), "secret");
  assert.equal(calls[1].options.headers.authorization, "Bearer access");
});

test("refresh exchanges only the server-held refresh token", async () => {
  let body;
  const oauth = new OAuthClient({
    baseUrl: "https://wiki.example/oauth2",
    clientId: "id",
    redirectUri: "https://site.example/callback",
    fetchImpl: async (_url, options) => {
      body = new URLSearchParams(options.body);
      return response({ access_token: "new", expires_in: 100 });
    },
  });

  const tokens = await oauth.refresh("refresh-private");
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "refresh-private");
  assert.equal(tokens.accessToken, "new");
});
