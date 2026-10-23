import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const COOKIE_DEFAULTS = { httpOnly: true, sameSite: "Lax", path: "/api/wiki" };

function keyFromSecret(secret) {
  return createHash("sha256").update(String(secret)).digest();
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

export class SessionCodec {
  constructor({ secret, ttlMs = 28_800_000, now = Date.now }) {
    if (Buffer.byteLength(String(secret || "")) < 32) throw new TypeError("session secret must be at least 32 bytes");
    this.key = keyFromSecret(secret);
    this.ttlMs = ttlMs;
    this.now = now;
  }

  seal(payload, ttlMs = this.ttlMs) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify({ ...payload, exp: this.now() + ttlMs }));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, encode(iv), encode(encrypted), encode(tag)].join(".");
  }

  open(value) {
    try {
      const [version, ivValue, encryptedValue, tagValue, extra] = String(value || "").split(".");
      if (version !== VERSION || !ivValue || !encryptedValue || !tagValue || extra) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final(),
      ]);
      const payload = JSON.parse(plaintext.toString("utf8"));
      if (!Number.isFinite(payload.exp) || payload.exp <= this.now()) return null;
      delete payload.exp;
      return payload;
    } catch {
      return null;
    }
  }
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const settings = { ...COOKIE_DEFAULTS, ...options };
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${settings.path}`];
  if (Number.isFinite(settings.maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(settings.maxAge))}`);
  if (settings.httpOnly) parts.push("HttpOnly");
  if (settings.secure) parts.push("Secure");
  if (settings.sameSite) parts.push(`SameSite=${settings.sameSite}`);
  return parts.join("; ");
}
