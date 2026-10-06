import "./env.js";
import { createApp } from "./app";
import { loadKnownUsers } from "./auth";
import { installProcessLogging, log } from "./log";

// Fixed, not PORT: vite.config.ts proxies /api to 3001, and PORT is Vite's
// own port when a launcher sets it. Prod reads PORT in index-prod.ts.
const port = 3001;

installProcessLogging();
loadKnownUsers();

createApp().listen(port, () => {
  log.info("boot", "API listening", { port });
});
