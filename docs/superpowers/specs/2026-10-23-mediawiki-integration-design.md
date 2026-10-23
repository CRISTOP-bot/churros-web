# ChurrOS MediaWiki Integration Design

## Intent

Add a first-class Spanish-language wiki to ChurrOS without embedding MediaWiki's default interface. ChurrOS owns the reading and editing experience; MediaWiki remains the source of truth for pages, revisions, categories, permissions, and history.

## Repository findings

- The repository is a hand-authored static multipage site.
- The frontend uses HTML, a precompiled Tailwind 4 stylesheet, `css/custom.css`, and dependency-free browser JavaScript in `js/app.js`.
- There is no application backend, server router, database, account system, dependency manifest, automated test suite, or production deployment configuration.
- Navigation and footer markup are duplicated across the HTML pages.
- The development-only configuration uses VS Code Live Server on port 5501.
- The public origin is `https://www.churroslinux.org`.

## Goals

- Native ChurrOS UI for landing, search, article reading, categories, recent pages, featured pages, source editing, revision history, and revision diffs.
- A same-origin backend-for-frontend (BFF) that is the only browser-facing MediaWiki client.
- MediaWiki remains the only wiki content database.
- Per-user MediaWiki authentication and authorization through OAuth 2.0 Authorization Code with PKCE.
- Secure-by-default same-origin deployment on Arch Linux with nginx, Node.js, PHP-FPM, MariaDB, and MediaWiki.
- Dependency-free Node.js runtime and tests using Node's built-in test runner.

## Non-goals

- Rewriting the existing site or introducing a frontend framework.
- Replacing MediaWiki's administration UI.
- Duplicating articles in a ChurrOS database.
- Pretending ChurrOS has an existing SSO provider.
- Exposing MediaWiki, OAuth tokens, client secrets, or database credentials to browser JavaScript.

## Architecture

```text
Browser
  ├── static ChurrOS pages and native wiki UI
  └── same-origin /api/wiki/*
          │
          ▼
    Node.js BFF (loopback)
      ├── validation, throttling, origin checks, uniform errors
      ├── encrypted HttpOnly OAuth session cookie
      └── MediaWiki Action API + OAuth 2.0 endpoints
          │
          ▼
    MediaWiki 1.46.x (loopback PHP-FPM/nginx)
          │
          ▼
       MariaDB
```

The BFF uses only Node.js core APIs. Public reads call the MediaWiki Action API. Writes require a valid OAuth session, query `meta=userinfo&uiprop=rights`, require `edit` (and `createpage` for a missing title), fetch a MediaWiki CSRF token, and submit `action=edit` with `assert=user` and `baserevid` for conflict detection.

OAuth state, PKCE verifier, access token, refresh token, expiry, and basic profile data are sealed with AES-256-GCM in `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Browser code can query a minimal session-status endpoint but cannot read OAuth credentials.

## API contract

- `GET /api/wiki/home` — main page, featured category members, recent changes, and categories.
- `GET /api/wiki/search?q=` — full-text/prefix search.
- `GET /api/wiki/article?title=` — parsed page HTML, metadata, categories, and related links.
- `GET /api/wiki/source?title=` — current wikitext and base revision for the editor.
- `GET /api/wiki/categories?category=` — all categories or members of one category.
- `GET /api/wiki/recent` — recent page changes.
- `GET /api/wiki/history?title=` — revision metadata.
- `GET /api/wiki/diff?from=&to=` — MediaWiki-rendered revision diff.
- `POST /api/wiki/article` — create or update a page; OAuth and MediaWiki rights required.
- `GET /api/wiki/auth/status` — user identity and edit/create permissions.
- `GET /api/wiki/auth/login` — start OAuth 2.0 with PKCE.
- `GET /api/wiki/auth/callback` — validate state and exchange the code.
- `POST /api/wiki/auth/logout` — clear the local sealed session.
- `GET /api/wiki/health` — process/configuration health without secrets.

All errors use `{ "error": { "code", "message", "requestId" } }`. Inputs have explicit length/range limits. Responses use `Cache-Control` according to sensitivity. Mutation requests enforce a same-origin `Origin` header and JSON content type. The service never enables CORS.

## Content safety

MediaWiki's parser is responsible for converting wikitext to HTML. The frontend additionally parses returned fragments into an inert document, removes active/embedded elements, event handlers, inline styles, and unsafe URL schemes, then imports the safe nodes. Internal wiki links are rewritten to ChurrOS article routes. A strict CSP is documented at nginx.

## Authentication decision

There is no ChurrOS account system to federate. MediaWiki therefore acts as the identity and authorization authority through its official OAuth extension. This avoids shared databases, shared cookies, bot-wide attribution, and a second password prompt inside ChurrOS. OAuth setup is an external deployment prerequisite; without it the wiki remains fully readable and editing is disabled with an explicit explanation.

## Visual system

- **Churro orange:** `#ea580c` for primary actions and current context.
- **Toasted orange:** `#9a3412` for emphasis with sufficient light-background contrast.
- **Paper:** `#fffaf5` for the wiki reading surface.
- **Flour:** `#fef7f0` for secondary surfaces.
- **Ink:** `#1c1917` for primary text.
- **Night:** `#0f0802` for the existing dark theme.
- Typography remains Inter, already embedded in the compiled stylesheet; article measure is capped near 74 characters.

Desktop uses a compact left navigation rail, a central article column, and a contextual right rail only where it adds information. Mobile collapses contextual rails into horizontal, touch-scrollable controls and keeps 16px form text. The memorable element is a wide, direct search field that reads as the wiki's front door, not decorative hero copy.

## Deployment and lifecycle

Arch Linux production uses `mediawiki`, `nginx`, `php-fpm`, `mariadb`, Node.js, and the PHP extensions required by MediaWiki. MediaWiki and the BFF bind only to loopback; public nginx serves static files and proxies `/api/wiki/`. Persistent state is MariaDB plus MediaWiki uploads and configuration. Backups include a consistent DB dump, `LocalSettings.php`, uploaded files, OAuth keys, and BFF environment secrets. Upgrades back up first, upgrade packages/extensions together, run MediaWiki's update maintenance command, restart services, and perform smoke tests.

## External verification boundary

Unit and HTTP contract tests use a deterministic fake MediaWiki transport. Real OAuth, permissions, persistence, search indexing, and MediaWiki parsing require a configured MediaWiki instance and cannot be claimed from this repository alone.

