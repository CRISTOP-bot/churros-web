export class MediaWikiError extends Error {
  constructor(code, message, { status = 502, details = null, cause } = {}) {
    super(message, { cause });
    this.name = "MediaWikiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function appendParams(target, params) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue;
    target.set(key, value === true ? "1" : String(value));
  }
  target.set("format", "json");
  target.set("formatversion", "2");
  target.set("errorformat", "plaintext");
}

export class MediaWikiClient {
  constructor({ apiUrl, fetchImpl = globalThis.fetch, timeoutMs = 8_000, maxResponseBytes = 2_000_000, userAgent = "ChurrOS-Wiki/1.0" }) {
    if (!apiUrl) throw new TypeError("apiUrl is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.apiUrl = apiUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.userAgent = userAgent;
  }

  async request(params, { method = "GET", accessToken, signal } = {}) {
    const requestMethod = method.toUpperCase();
    const values = new URLSearchParams();
    appendParams(values, params);
    const url = new URL(this.apiUrl);
    const headers = {
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    const options = { method: requestMethod, headers };

    if (requestMethod === "GET") {
      url.search = values.toString();
    } else {
      headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      options.body = values.toString();
    }
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new DOMException("MediaWiki request timed out", "TimeoutError")), this.timeoutMs);
    options.signal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      let response;
      try {
        response = await this.fetchImpl(url.toString(), options);
      } catch (error) {
        if (timeoutController.signal.aborted) {
          throw new MediaWikiError("upstream_timeout", "MediaWiki tardó demasiado en responder.", { status: 504, cause: error });
        }
        throw new MediaWikiError("upstream_unavailable", "No fue posible conectar con MediaWiki.", { status: 502, cause: error });
      }

      let payload;
      try {
        const declaredSize = Number(response.headers.get("content-length") || 0);
        if (declaredSize > this.maxResponseBytes) {
          throw new MediaWikiError("upstream_response_too_large", "MediaWiki devolvió una respuesta demasiado grande.", { status: 502 });
        }
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
              throw new MediaWikiError("upstream_response_too_large", "MediaWiki devolvió una respuesta demasiado grande.", { status: 502 });
            }
            chunks.push(value);
          }
          payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
        } else {
          payload = await response.json();
        }
      } catch (error) {
        if (error instanceof MediaWikiError) throw error;
        if (timeoutController.signal.aborted) {
          throw new MediaWikiError("upstream_timeout", "MediaWiki tardó demasiado en responder.", { status: 504, cause: error });
        }
        throw new MediaWikiError("invalid_upstream_response", "MediaWiki devolvió una respuesta no válida.", { status: 502, cause: error });
      }

      if (!response.ok) {
        throw new MediaWikiError("upstream_http_error", "MediaWiki rechazó la solicitud.", {
          status: response.status === 429 ? 503 : 502,
          details: { upstreamStatus: response.status },
        });
      }

      const apiError = payload?.errors?.[0] || payload?.error;
      if (apiError) {
        const code = String(apiError.code || "upstream_api_error");
        throw new MediaWikiError(
          code,
          String(apiError.text || apiError.info || "MediaWiki no pudo completar la solicitud."),
          { status: 502, details: { upstreamCode: code } },
        );
      }

      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}
