# ChurrOS MediaWiki Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native ChurrOS wiki UI backed by a secure same-origin MediaWiki integration service and document an Arch Linux production deployment.

**Architecture:** A dependency-free Node.js BFF translates narrow ChurrOS API routes into MediaWiki Action API/OAuth 2.0 calls. Static HTML/CSS/JS renders the wiki natively while MediaWiki and MariaDB remain independent services and the content source of truth.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js 22 core APIs, Node test runner, MediaWiki 1.46.x, OAuth extension, PHP 8.3+, nginx, PHP-FPM, MariaDB, systemd.

**Spec:** `docs/superpowers/specs/2026-10-23-mediawiki-integration-design.md`

## Global Constraints

- Do not rewrite the existing application or replace its technologies.
- MediaWiki is the only source of truth for wiki content.
- Do not expose OAuth tokens, client secrets, bot credentials, or database credentials to the browser.
- Do not use an iframe as the primary integration.
- Do not claim live MediaWiki verification without a configured instance.
- Preserve unrelated working-tree changes.

## Review Focus

- Malformed, overlong, or repeated query/body input returns a bounded 4xx response and never reaches MediaWiki.
- Expired/tampered OAuth cookies fail closed without leaking token material.
- Missing `edit`/`createpage` rights prevents writes even when the frontend is manipulated.
- MediaWiki timeouts, invalid JSON, API errors, and edit conflicts map to stable errors without crashing the service.
- Parsed article/diff HTML cannot execute scripts, event handlers, embedded content, or unsafe links in the browser.

---

### Task 1: MediaWiki client and domain service

**Files:**
- Create: `server/mediawiki-client.js`
- Create: `server/wiki-service.js`
- Test: `tests/mediawiki-client.test.js`
- Test: `tests/wiki-service.test.js`

**Interfaces:**
- Produces: `MediaWikiClient.request(params, options)`, `WikiService` read methods, `WikiService.getPermissions(accessToken)`, and `WikiService.saveArticle(input, accessToken)`.

- [ ] Write failing tests for Action API parameter construction, timeout/invalid response handling, article normalization, search, history, diff, permissions, token acquisition, create/edit rights, and edit conflicts.
- [ ] Run `npm test -- tests/mediawiki-client.test.js tests/wiki-service.test.js` and confirm failures are caused by missing production modules.
- [ ] Implement the minimal client and service with injected `fetch`.
- [ ] Re-run focused tests and confirm they pass.

### Task 2: OAuth session and security primitives

**Files:**
- Create: `server/config.js`
- Create: `server/session.js`
- Create: `server/oauth.js`
- Create: `server/security.js`
- Test: `tests/session.test.js`
- Test: `tests/oauth.test.js`
- Test: `tests/security.test.js`

**Interfaces:**
- Produces: configuration validation, AES-GCM cookie sealing, OAuth PKCE start/callback/refresh, same-origin guard, JSON body limiter, and per-IP rate limiter.

- [ ] Write failing tests for config redaction, cookie tampering/expiry, PKCE challenge, state mismatch, token exchange, origin checks, body limits, and throttling.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the primitives using Node core crypto/web APIs.
- [ ] Re-run focused tests and confirm they pass.

### Task 3: HTTP API

**Files:**
- Create: `server/app.js`
- Create: `server/index.js`
- Test: `tests/app.test.js`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: the `/api/wiki/*` routes in the design contract and a runnable HTTP service.

- [ ] Write failing black-box HTTP tests for every route, validation failure, unauthenticated write, insufficient rights, MediaWiki failure, no-CORS behavior, secret-free health, and consistent error shape.
- [ ] Run `npm test -- tests/app.test.js` and confirm expected failures.
- [ ] Implement route dispatch, response headers, auth cookie handling, request IDs, and graceful shutdown.
- [ ] Re-run focused tests and confirm they pass.

### Task 4: Native wiki frontend

**Files:**
- Create: `wiki.html`
- Create: `css/wiki.css`
- Create: `js/wiki.js`
- Create: `js/wiki-core.js`
- Test: `tests/wiki-core.test.js`
- Modify: `index.html`
- Modify: `about.html`
- Modify: `download.html`
- Modify: `blog.html`
- Modify: `404.html`
- Modify: `sitemap-0.xml`

**Interfaces:**
- Consumes: Task 3 JSON API.
- Produces: native routes through `wiki.html?article=`, accessible interactions, safe HTML transformation, editor, history, and diff views.

- [ ] Write failing tests for title/query routing, URL rewriting, dangerous-attribute detection, and view-model normalization.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement pure frontend helpers, then the browser controller and responsive UI.
- [ ] Add a Wiki navigation item to existing pages and sitemap.
- [ ] Re-run focused tests and confirm they pass.

### Task 5: Arch Linux deployment and operator documentation

**Files:**
- Create: `.env.example`
- Create: `deploy/churros-wiki-api.service`
- Create: `deploy/nginx-churros-wiki.conf`
- Create: `deploy/mediawiki/LocalSettings.churros.php.example`
- Create: `docs/mediawiki-arch-linux.md`
- Create: `package.json`

**Interfaces:**
- Consumes: runtime requirements from Tasks 1–4.
- Produces: reproducible dependency, installation, OAuth, service, proxy, persistence, backup, restore, upgrade, and smoke-test procedures.

- [ ] Add executable configuration checks/smoke commands where practical; human documentation itself is not source-grep tested.
- [ ] Document exact Arch package/service/config names and keep secrets as environment placeholders.
- [ ] Validate Node syntax, JSON, systemd unit structure, and nginx guidance without changing host services.

### Task 6: Full verification

**Files:** All changed files.

- [ ] Run `npm test` and report exact pass/fail counts.
- [ ] Run `npm run check` for syntax and static validation.
- [ ] Start the BFF with fake/test configuration and verify health plus static-site serving/proxy assumptions.
- [ ] Inspect `git diff --check`, `git status --short`, and the final diff for secrets or unrelated changes.
- [ ] Record that real MediaWiki/OAuth/persistence verification remains external unless a live instance is supplied.
