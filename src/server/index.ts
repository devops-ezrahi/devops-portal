import "./env.js";
import { createApp } from "./app";
import { loadKnownUsers } from "./auth";
import { installProcessLogging, log } from "./log";

const port = Number(process.env.PORT ?? 8080);

installProcessLogging();
loadKnownUsers();

createApp().listen(port, () => {
  log.info("boot", "API listening", { port });
});
