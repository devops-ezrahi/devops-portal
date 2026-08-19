import "./env.js";
import { createApp } from "./app";
import { installProcessLogging, log } from "./log";

const port = Number(process.env.PORT ?? 8080);

installProcessLogging();

createApp().listen(port, () => {
  log.info("boot", "API listening", { port });
});
