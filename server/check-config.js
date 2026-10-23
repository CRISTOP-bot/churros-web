import { loadConfig, publicConfig } from "./config.js";

try {
  const config = loadConfig();
  console.log(JSON.stringify({ valid: true, ...publicConfig(config) }, null, 2));
} catch (error) {
  console.error(`Invalid wiki API configuration: ${error.message}`);
  process.exitCode = 1;
}
