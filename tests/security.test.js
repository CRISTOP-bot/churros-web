import assert from "node:assert/strict";
import test from "node:test";

import { HttpError, RateLimiter, assertSameOrigin, readJson } from "../server/security.js";

test("same-origin guard accepts the configured origin and rejects missing or foreign origins", () => {
  const expected = "https://www.churroslinux.org";
  assert.doesNotThrow(() => assertSameOrigin(new Request("https://site/api", {
    method: "POST", headers: { origin: expected },
  }), expected));
  assert.throws(
    () => assertSameOrigin(new Request("https://site/api", { method: "POST" }), expected),
    (error) => error instanceof HttpError && error.status === 403,
  );
  assert.throws(
    () => assertSameOrigin(new Request("https://site/api", { method: "POST", headers: { origin: "https://evil.example" } }), expected),
    (error) => error instanceof HttpError && error.code === "invalid_origin",
  );
});

test("readJson accepts JSON objects and rejects other content types", async () => {
  const value = await readJson(new Request("https://site/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Guía" }),
  }));
  assert.deepEqual(value, { title: "Guía" });

  await assert.rejects(
    readJson(new Request("https://site/api", { method: "POST", body: "title=x" })),
    (error) => error instanceof HttpError && error.status === 415,
  );
});

test("readJson enforces the byte limit before parsing", async () => {
  await assert.rejects(
    readJson(new Request("https://site/api", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "200" },
      body: JSON.stringify({ text: "x".repeat(200) }),
    }), { maxBytes: 100 }),
    (error) => error instanceof HttpError && error.code === "body_too_large",
  );
});

test("rate limiter permits a bounded window and resets after it", () => {
  let now = 1_000;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1_000, now: () => now });

  assert.deepEqual(limiter.consume("ip"), { allowed: true, remaining: 1, retryAfter: 0 });
  assert.deepEqual(limiter.consume("ip"), { allowed: true, remaining: 0, retryAfter: 0 });
  assert.deepEqual(limiter.consume("ip"), { allowed: false, remaining: 0, retryAfter: 1 });
  now = 2_001;
  assert.equal(limiter.consume("ip").allowed, true);
});
