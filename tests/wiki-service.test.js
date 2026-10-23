import assert from "node:assert/strict";
import test from "node:test";

import { WikiService, WikiServiceError } from "../server/wiki-service.js";

function queuedClient(responses) {
  const calls = [];
  return {
    calls,
    async request(params, options = {}) {
      calls.push({ params, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return structuredClone(next);
    },
  };
}

test("getArticle normalizes parsed HTML, categories, and related main-namespace links", async () => {
  const client = queuedClient([{ parse: {
    title: "Instalación",
    pageid: 8,
    revid: 42,
    text: "<p>Lista</p>",
    categories: [{ category: "Guías" }, { category: "Arch Linux", hidden: true }],
    links: [{ title: "Primeros pasos", ns: 0 }, { title: "Category:Guías", ns: 14 }],
  } }]);
  const service = new WikiService({ client });

  const article = await service.getArticle(" Instalación ");

  assert.deepEqual(article, {
    title: "Instalación",
    pageId: 8,
    revisionId: 42,
    html: "<p>Lista</p>",
    categories: ["Guías"],
    related: ["Primeros pasos"],
  });
  assert.equal(client.calls[0].params.page, "Instalación");
  assert.equal(client.calls[0].params.prop, "text|categories|links");
});

test("getArticle maps a missing page to not_found", async () => {
  const service = new WikiService({ client: queuedClient([{ error: { code: "missingtitle" } }]) });
  await assert.rejects(
    service.getArticle("No existe"),
    (error) => error instanceof WikiServiceError && error.code === "not_found",
  );
});

test("search returns bounded result summaries", async () => {
  const client = queuedClient([{ query: { search: [
    { title: "ChurrOS", pageid: 1, snippet: "<span class=\"searchmatch\">Linux</span>", timestamp: "2026-01-01T00:00:00Z" },
  ] } }]);
  const service = new WikiService({ client });

  const results = await service.search("linux", 200);

  assert.equal(client.calls[0].params.srlimit, 20);
  assert.deepEqual(results[0], {
    title: "ChurrOS",
    pageId: 1,
    snippet: "<span class=\"searchmatch\">Linux</span>",
    timestamp: "2026-01-01T00:00:00Z",
  });
});

test("getHistory maps revisions without exposing suppressed data", async () => {
  const client = queuedClient([{ query: { pages: [{ pageid: 3, title: "Guía", revisions: [
    { revid: 12, parentid: 11, user: "Ada", timestamp: "2026-01-02T00:00:00Z", comment: "Mejora", size: 900 },
    { revid: 11, parentid: 10, userhidden: true, timestamp: "2026-01-01T00:00:00Z", commenthidden: true, size: 800 },
  ] }] } }]);
  const service = new WikiService({ client });

  const history = await service.getHistory("Guía", 10);

  assert.equal(history.revisions[0].user, "Ada");
  assert.equal(history.revisions[1].user, null);
  assert.equal(history.revisions[1].comment, null);
});

test("getDiff returns MediaWiki diff HTML and revision metadata", async () => {
  const service = new WikiService({ client: queuedClient([{ compare: {
    fromrevid: 10, torevid: 11, fromtitle: "Guía", totitle: "Guía", "*": "<tr><td>diff</td></tr>",
  } }]) });

  assert.deepEqual(await service.getDiff(10, 11), {
    fromRevisionId: 10,
    toRevisionId: 11,
    title: "Guía",
    html: "<tr><td>diff</td></tr>",
  });
});

test("getPermissions reports authenticated edit and create rights", async () => {
  const client = queuedClient([{ query: { userinfo: { id: 7, name: "Lina", rights: ["read", "edit", "createpage"] } } }]);
  const service = new WikiService({ client });

  assert.deepEqual(await service.getPermissions("token"), {
    authenticated: true,
    name: "Lina",
    canEdit: true,
    canCreate: true,
  });
  assert.equal(client.calls[0].options.accessToken, "token");
});

test("saveArticle refuses editing without MediaWiki edit rights", async () => {
  const service = new WikiService({ client: queuedClient([
    { query: { userinfo: { id: 7, name: "Lina", rights: ["read"] } } },
  ]) });

  await assert.rejects(
    service.saveArticle({ title: "Guía", text: "Texto", summary: "Cambio", baseRevisionId: 2 }, "token"),
    (error) => error instanceof WikiServiceError && error.code === "forbidden",
  );
});

test("saveArticle refuses creating pages without createpage rights", async () => {
  const service = new WikiService({ client: queuedClient([
    { query: { userinfo: { id: 7, name: "Lina", rights: ["edit"] } } },
    { query: { pages: [{ title: "Nueva", missing: true }] } },
  ]) });

  await assert.rejects(
    service.saveArticle({ title: "Nueva", text: "Texto", summary: "Nueva" }, "token"),
    (error) => error instanceof WikiServiceError && error.code === "forbidden_create",
  );
});

test("saveArticle obtains a CSRF token and submits conflict-safe edits", async () => {
  const client = queuedClient([
    { query: { userinfo: { id: 7, name: "Lina", rights: ["edit", "createpage"] } } },
    { query: { pages: [{ pageid: 4, title: "Guía", revisions: [{ revid: 20, slots: { main: { content: "Viejo" } } }] }] } },
    { query: { tokens: { csrftoken: "csrf-token" } } },
    { edit: { result: "Success", pageid: 4, title: "Guía", newrevid: 21, oldrevid: 20 } },
  ]);
  const service = new WikiService({ client });

  const saved = await service.saveArticle({
    title: "Guía", text: "Nuevo", summary: "Actualiza", baseRevisionId: 20,
  }, "oauth-token");

  assert.deepEqual(saved, { title: "Guía", pageId: 4, revisionId: 21, previousRevisionId: 20, created: false });
  assert.equal(client.calls[2].params.type, "csrf");
  assert.equal(client.calls[3].params.baserevid, 20);
  assert.equal(client.calls[3].params.assert, "user");
  assert.equal(client.calls[3].options.accessToken, "oauth-token");
});

test("saveArticle maps edit conflicts to a stable conflict error", async () => {
  const conflict = Object.assign(new Error("Edit conflict"), { code: "editconflict" });
  const client = queuedClient([
    { query: { userinfo: { id: 7, name: "Lina", rights: ["edit"] } } },
    { query: { pages: [{ pageid: 4, title: "Guía", revisions: [{ revid: 20, slots: { main: { content: "Viejo" } } }] }] } },
    { query: { tokens: { csrftoken: "csrf-token" } } },
    conflict,
  ]);
  const service = new WikiService({ client });

  await assert.rejects(
    service.saveArticle({ title: "Guía", text: "Nuevo", baseRevisionId: 20 }, "token"),
    (error) => error instanceof WikiServiceError && error.code === "edit_conflict",
  );
});

test("saveArticle preserves create intent when another editor created the page", async () => {
  const client = queuedClient([
    { query: { userinfo: { id: 7, name: "Lina", rights: ["edit", "createpage"] } } },
    { query: { pages: [{ pageid: 4, title: "Nueva", revisions: [{ revid: 20 }] }] } },
  ]);
  const service = new WikiService({ client });

  await assert.rejects(
    service.saveArticle({ title: "Nueva", text: "Texto", baseRevisionId: null }, "token"),
    (error) => error instanceof WikiServiceError && error.code === "edit_conflict" && error.status === 409,
  );
  assert.equal(client.calls.length, 2);
});
