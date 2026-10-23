import { MediaWikiError } from "./mediawiki-client.js";

export class WikiServiceError extends Error {
  constructor(code, message, { status = 500, cause } = {}) {
    super(message, { cause });
    this.name = "WikiServiceError";
    this.code = code;
    this.status = status;
  }
}

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || minimum));

function cleanTitle(title) {
  return String(title ?? "").trim().replace(/\s+/g, " ");
}

function firstPage(payload) {
  return payload?.query?.pages?.[0] ?? null;
}

export class WikiService {
  constructor({ client, mainPage = "Página principal", featuredCategory = "Destacados" }) {
    if (!client?.request) throw new TypeError("client with request() is required");
    this.client = client;
    this.mainPage = mainPage;
    this.featuredCategory = featuredCategory;
  }

  async getArticle(title) {
    const normalizedTitle = cleanTitle(title);
    try {
      const payload = await this.client.request({
        action: "parse",
        page: normalizedTitle,
        prop: "text|categories|links",
        redirects: true,
        disableeditsection: true,
      });
      if (payload?.error?.code === "missingtitle" || !payload?.parse) {
        throw new WikiServiceError("not_found", "El artículo no existe.", { status: 404 });
      }
      const page = payload.parse;
      return {
        title: String(page.title || normalizedTitle),
        pageId: Number(page.pageid) || null,
        revisionId: Number(page.revid) || null,
        html: String(page.text || ""),
        categories: (page.categories || [])
          .filter((item) => !item.hidden)
          .map((item) => String(item.category)),
        related: (page.links || [])
          .filter((item) => Number(item.ns) === 0)
          .map((item) => String(item.title))
          .filter((item) => item !== normalizedTitle)
          .slice(0, 12),
      };
    } catch (error) {
      if (error instanceof WikiServiceError) throw error;
      if (error instanceof MediaWikiError && error.code === "missingtitle") {
        throw new WikiServiceError("not_found", "El artículo no existe.", { status: 404, cause: error });
      }
      throw error;
    }
  }

  async search(query, limit = 10) {
    const payload = await this.client.request({
      action: "query",
      list: "search",
      srsearch: String(query ?? "").trim(),
      srnamespace: 0,
      srprop: "snippet|timestamp",
      srlimit: clamp(limit, 1, 20),
    });
    return (payload?.query?.search || []).map((result) => ({
      title: String(result.title || ""),
      pageId: Number(result.pageid) || null,
      snippet: String(result.snippet || ""),
      timestamp: result.timestamp || null,
    }));
  }

  async getSource(title, accessToken) {
    const payload = await this.client.request({
      action: "query",
      prop: "info|revisions",
      titles: cleanTitle(title),
      rvprop: "ids|timestamp|content",
      rvslots: "main",
      redirects: true,
    }, accessToken ? { accessToken } : undefined);
    const page = firstPage(payload);
    const revision = page?.revisions?.[0];
    return {
      title: String(page?.title || cleanTitle(title)),
      pageId: Number(page?.pageid) || null,
      revisionId: Number(revision?.revid) || null,
      timestamp: revision?.timestamp || null,
      text: String(revision?.slots?.main?.content ?? ""),
      missing: Boolean(page?.missing),
    };
  }

  async getHistory(title, limit = 20) {
    const payload = await this.client.request({
      action: "query",
      prop: "revisions",
      titles: cleanTitle(title),
      rvprop: "ids|timestamp|user|comment|size|flags",
      rvlimit: clamp(limit, 1, 50),
    });
    const page = firstPage(payload);
    if (!page || page.missing) throw new WikiServiceError("not_found", "El artículo no existe.", { status: 404 });
    return {
      title: String(page.title),
      pageId: Number(page.pageid) || null,
      revisions: (page.revisions || []).map((revision) => ({
        revisionId: Number(revision.revid),
        parentRevisionId: Number(revision.parentid) || null,
        user: revision.userhidden ? null : String(revision.user || ""),
        timestamp: revision.timestamp || null,
        comment: revision.commenthidden ? null : String(revision.comment || ""),
        size: Number(revision.size) || 0,
        minor: Boolean(revision.minor),
      })),
    };
  }

  async getDiff(fromRevisionId, toRevisionId) {
    const payload = await this.client.request({
      action: "compare",
      fromrev: Number(fromRevisionId),
      torev: Number(toRevisionId),
      prop: "diff|ids|title",
      difftype: "table",
    });
    const diff = payload.compare;
    if (!diff) throw new WikiServiceError("not_found", "No se encontraron esas revisiones.", { status: 404 });
    return {
      fromRevisionId: Number(diff.fromrevid),
      toRevisionId: Number(diff.torevid),
      title: String(diff.totitle || diff.fromtitle || ""),
      html: String(diff["*"] || diff.body || ""),
    };
  }

  async getPermissions(accessToken) {
    if (!accessToken) return { authenticated: false, name: null, canEdit: false, canCreate: false };
    const payload = await this.client.request({
      action: "query",
      meta: "userinfo",
      uiprop: "rights",
      assert: "user",
    }, { accessToken });
    const user = payload?.query?.userinfo;
    const rights = new Set(user?.rights || []);
    return {
      authenticated: Boolean(user && !user.anon && Number(user.id) > 0),
      name: user?.name ? String(user.name) : null,
      canEdit: rights.has("edit"),
      canCreate: rights.has("createpage"),
    };
  }

  async saveArticle(input, accessToken) {
    const permissions = await this.getPermissions(accessToken);
    if (!permissions.authenticated || !permissions.canEdit) {
      throw new WikiServiceError("forbidden", "Tu cuenta de MediaWiki no puede editar artículos.", { status: 403 });
    }

    const current = await this.getSource(input.title, accessToken);
    if (current.missing && !permissions.canCreate) {
      throw new WikiServiceError("forbidden_create", "Tu cuenta de MediaWiki no puede crear artículos.", { status: 403 });
    }

    const tokenPayload = await this.client.request({
      action: "query",
      meta: "tokens",
      type: "csrf",
      assert: "user",
    }, { accessToken });
    const csrfToken = tokenPayload?.query?.tokens?.csrftoken;
    if (!csrfToken) throw new WikiServiceError("csrf_unavailable", "MediaWiki no entregó un token de edición.", { status: 502 });

    try {
      const payload = await this.client.request({
        action: "edit",
        title: cleanTitle(input.title),
        text: String(input.text ?? ""),
        summary: String(input.summary ?? ""),
        token: csrfToken,
        assert: "user",
        baserevid: current.missing ? undefined : Number(input.baseRevisionId || current.revisionId),
        createonly: current.missing || undefined,
      }, { method: "POST", accessToken });
      if (payload?.edit?.result !== "Success") {
        throw new WikiServiceError("edit_failed", "MediaWiki no confirmó la edición.", { status: 502 });
      }
      return {
        title: String(payload.edit.title || current.title),
        pageId: Number(payload.edit.pageid) || current.pageId,
        revisionId: Number(payload.edit.newrevid) || null,
        previousRevisionId: Number(payload.edit.oldrevid) || null,
        created: current.missing,
      };
    } catch (error) {
      if (error?.code === "editconflict") {
        throw new WikiServiceError("edit_conflict", "El artículo cambió mientras lo editabas. Recarga antes de guardar.", {
          status: 409,
          cause: error,
        });
      }
      throw error;
    }
  }

  async getCategories(category, limit = 20) {
    if (category) {
      const title = cleanTitle(category).replace(/^Categor(?:y|ía):/i, "");
      const payload = await this.client.request({
        action: "query",
        list: "categorymembers",
        cmtitle: `Categoría:${title}`,
        cmnamespace: 0,
        cmlimit: clamp(limit, 1, 50),
        cmprop: "ids|title|timestamp",
      });
      return { category: title, members: payload?.query?.categorymembers || [] };
    }
    const payload = await this.client.request({
      action: "query",
      list: "allcategories",
      aclimit: clamp(limit, 1, 50),
      acprop: "size",
    });
    return { categories: payload?.query?.allcategories || [] };
  }

  async getRecent(limit = 10) {
    const payload = await this.client.request({
      action: "query",
      list: "recentchanges",
      rcnamespace: 0,
      rctype: "edit|new",
      rcprop: "title|ids|timestamp|user|comment|flags",
      rclimit: clamp(limit, 1, 25),
      rctoponly: true,
    });
    return (payload?.query?.recentchanges || []).map((change) => ({
      title: String(change.title || ""),
      revisionId: Number(change.revid) || null,
      previousRevisionId: Number(change.old_revid) || null,
      timestamp: change.timestamp || null,
      user: change.userhidden ? null : String(change.user || ""),
      comment: change.commenthidden ? null : String(change.comment || ""),
      created: change.type === "new" || Boolean(change.new),
    }));
  }

  async getHome() {
    const [article, featured, recent, categoryData] = await Promise.all([
      this.getArticle(this.mainPage),
      this.getCategories(this.featuredCategory, 8),
      this.getRecent(8),
      this.getCategories(null, 12),
    ]);
    return {
      article,
      featured: featured.members,
      recent,
      categories: categoryData.categories,
    };
  }
}
