function requiredUrl(name, value) {
  if (!value) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error(`${name} must use HTTPS or loopback HTTP`);
  }
  return url.toString().replace(/\/$/, "");
}

function numberFromEnv(name, value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const sessionSecret = String(env.SESSION_SECRET || "");
  if (Buffer.byteLength(sessionSecret) < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes");

  const publicOrigin = requiredUrl("PUBLIC_ORIGIN", env.PUBLIC_ORIGIN);
  const apiUrl = requiredUrl("WIKI_API_URL", env.WIKI_API_URL);
  const oauthEnabled = Boolean(env.WIKI_OAUTH_CLIENT_ID && env.WIKI_OAUTH_BASE_URL && env.WIKI_OAUTH_REDIRECT_URI);
  const oauth = {
    enabled: oauthEnabled,
    baseUrl: oauthEnabled ? requiredUrl("WIKI_OAUTH_BASE_URL", env.WIKI_OAUTH_BASE_URL) : null,
    clientId: oauthEnabled ? String(env.WIKI_OAUTH_CLIENT_ID) : null,
    clientSecret: oauthEnabled ? String(env.WIKI_OAUTH_CLIENT_SECRET || "") : null,
    redirectUri: oauthEnabled ? requiredUrl("WIKI_OAUTH_REDIRECT_URI", env.WIKI_OAUTH_REDIRECT_URI) : null,
    scope: String(env.WIKI_OAUTH_SCOPE || "basic editpage createeditmovepage"),
  };

  return Object.freeze({
    environment: String(env.NODE_ENV || "development"),
    host: String(env.HOST || "127.0.0.1"),
    port: numberFromEnv("PORT", env.PORT, 3000, { max: 65_535 }),
    publicOrigin,
    wiki: Object.freeze({
      apiUrl,
      mainPage: String(env.WIKI_MAIN_PAGE || "Página principal"),
      featuredCategory: String(env.WIKI_FEATURED_CATEGORY || "Destacados"),
      timeoutMs: numberFromEnv("WIKI_TIMEOUT_MS", env.WIKI_TIMEOUT_MS, 8_000, { min: 500, max: 30_000 }),
    }),
    oauth: Object.freeze(oauth),
    session: Object.freeze({
      secret: sessionSecret,
      ttlMs: numberFromEnv("SESSION_TTL_SECONDS", env.SESSION_TTL_SECONDS, 28_800, { min: 300, max: 604_800 }) * 1_000,
      secure: publicOrigin.startsWith("https://"),
    }),
    rateLimit: Object.freeze({
      read: numberFromEnv("RATE_LIMIT_READ", env.RATE_LIMIT_READ, 120, { max: 10_000 }),
      write: numberFromEnv("RATE_LIMIT_WRITE", env.RATE_LIMIT_WRITE, 20, { max: 1_000 }),
      windowMs: 60_000,
    }),
  });
}

export function publicConfig(config) {
  return {
    environment: config.environment,
    wikiConfigured: Boolean(config.wiki?.apiUrl),
    oauthEnabled: Boolean(config.oauth?.enabled),
    mainPage: config.wiki?.mainPage,
  };
}
