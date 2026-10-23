export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function headerValue(request, name) {
  if (request?.headers?.get) return request.headers.get(name);
  return request?.headers?.[name.toLowerCase()] ?? request?.headers?.[name] ?? null;
}

export function assertSameOrigin(request, expectedOrigin) {
  const origin = headerValue(request, "origin");
  if (!origin || origin !== new URL(expectedOrigin).origin) {
    throw new HttpError(403, "invalid_origin", "El origen de la solicitud no está autorizado.");
  }
}

export async function readJson(request, { maxBytes = 262_144 } = {}) {
  const contentType = String(headerValue(request, "content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "La solicitud debe usar application/json.");
  }
  const declaredLength = Number(headerValue(request, "content-length") || 0);
  if (declaredLength > maxBytes) throw new HttpError(413, "body_too_large", "La solicitud es demasiado grande.");

  let text;
  if (typeof request.text === "function") {
    text = await request.text();
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, "body_too_large", "La solicitud es demasiado grande.");
      chunks.push(chunk);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, "body_too_large", "La solicitud es demasiado grande.");
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("object required");
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "El cuerpo JSON no es válido.");
  }
}

export class RateLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.entries = new Map();
  }

  consume(key) {
    const currentTime = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= currentTime) {
      entry = { count: 0, resetAt: currentTime + this.windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1_000)),
      };
    }
    entry.count += 1;
    return { allowed: true, remaining: this.limit - entry.count, retryAfter: 0 };
  }
}
