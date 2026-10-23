import { createServer } from "node:http";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MediaWikiClient } from "./mediawiki-client.js";
import { OAuthClient } from "./oauth.js";
import { SessionCodec } from "./session.js";
import { WikiService } from "./wiki-service.js";

const config = loadConfig();
const client = new MediaWikiClient({ apiUrl: config.wiki.apiUrl, timeoutMs: config.wiki.timeoutMs });
const service = new WikiService({
  client,
  mainPage: config.wiki.mainPage,
  featuredCategory: config.wiki.featuredCategory,
});
const oauth = config.oauth.enabled ? new OAuthClient(config.oauth) : null;
const sessionCodec = new SessionCodec(config.session);
const server = createServer(createApp({ config, service, oauth, sessionCodec }));

server.listen(config.port, config.host, () => {
  console.log(`ChurrOS wiki API listening on http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing ChurrOS wiki API`);
  server.close((error) => {
    if (error) {
      console.error("Failed to close HTTP server", { name: error.name });
      process.exitCode = 1;
    }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
