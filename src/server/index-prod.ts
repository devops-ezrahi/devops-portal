import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);
// This bundled file runs from /app/dist/server/index-prod.js and the
// Dockerfile copies the built client to /app/dist/client — one level up,
// not two (that would resolve to the non-existent /app/client).
const clientDist = path.join(__dirname, "../client");

const app = createApp();

app.use(express.static(clientDist));
// SPA fallback: Express 5 (path-to-regexp v7+) rejects a bare "*" path
// pattern, so use a pathless middleware as the final handler instead.
app.use((_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(port, () => {
  console.log(`DevOps portal listening on port ${port}`);
  console.log(`Serving static files from: ${clientDist}`);
});
