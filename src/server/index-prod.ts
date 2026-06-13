import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const clientDist = path.join(__dirname, "../../client");

const app = createApp();

app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(port, () => {
  console.log(`DevOps portal listening on port ${port}`);
  console.log(`Serving static files from: ${clientDist}`);
});
