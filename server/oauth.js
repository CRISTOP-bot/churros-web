import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class OAuthError extends Error {
  constructor(code, message, { status = 400, cause } = {}) {
    super(message, { cause });
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

const randomBase64Url = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OAuthClient {
  constructor({ baseUrl, clientId, clientSecret = "", redirectUri, scope = "basic editpage", fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8_000, maxResponseBytes = 256_000 }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scope = scope;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  createAuthorization() {
    const state = randomBase64Url(24);
    const verifier = randomBase64Url(48);
    const url = new URL(`${this.baseUrl}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scope,
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state, verifier };
  }

  async exchangeCode({ code, state, expectedState, verifier }) {
    if (!safeEqual(state, expectedState)) {
      throw new OAuthError("oauth_state_mismatch", "La respuesta de acceso no coincide con la sesión iniciada.", { status: 403 });
    }
    const tokens = await this.#tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: this.redirectUri,
    });
    const profile = await this.#requestJson(`${this.baseUrl}/resource/profile`, {
      headers: { accept: "application/json", authorization: `Bearer ${tokens.accessToken}` },
    }, "oauth_profile_failed");
    return {
      ...tokens,
      user: {
        id: profile.sub ?? profile.id ?? null,
        name: String(profile.username || profile.name || profile.preferred_username || ""),
      },
    };
  }

  async refresh(refreshToken) {
    return this.#tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async #tokenRequest(values) {
    const body = new URLSearchParams({ ...values, client_id: this.clientId });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    const payload = await this.#requestJson(`${this.baseUrl}/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
    }, "oauth_token_failed");
    if (!payload.access_token) throw new OAuthError("oauth_token_invalid", "MediaWiki no entregó un token de acceso.", { status: 502 });
    return {
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      tokenType: String(payload.token_type || "Bearer"),
      expiresAt: this.now() + Math.max(1, Number(payload.expires_in) || 3600) * 1_000,
      scope: String(payload.scope || this.scope),
    };
  }

  async #requestJson(url, options, code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("OAuth request timed out", "TimeoutError")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...options, signal: controller.signal });
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > this.maxResponseBytes) throw new OAuthError(code, "MediaWiki devolvió una respuesta OAuth demasiado grande.", { status: 502 });
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maxResponseBytes) {
            await reader.cancel();
            throw new OAuthError(code, "MediaWiki devolvió una respuesta OAuth demasiado grande.", { status: 502 });
          }
          chunks.push(Buffer.from(value));
        }
      }
      const payload = reader ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : await response.json();
      if (!response.ok || payload.error) {
        throw new OAuthError(code, String(payload.error_description || payload.error || "MediaWiki rechazó la autorización."), { status: 502 });
      }
      return payload;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      if (controller.signal.aborted) {
        throw new OAuthError("oauth_timeout", "MediaWiki tardó demasiado en responder.", { status: 504, cause: error });
      }
      throw new OAuthError(code, "MediaWiki devolvió una respuesta OAuth no válida.", { status: 502, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
