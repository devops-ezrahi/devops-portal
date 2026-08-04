import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createArtifactoryRouter } from "./router";
import type { ArtifactoryApi, FolderUploadInput } from "../../types";

vi.mock("../../auth", () => ({ isAdmin: () => false }));

describe("folder-upload route", () => {
  it("keeps the folder structure in each file's name", async () => {
    let received: FolderUploadInput | undefined;
    const api = {
      async submitFolderUpload(input: FolderUploadInput) {
        received = input;
        return { id: "ART-0001" };
      },
    } as unknown as ArtifactoryApi;

    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: "dev" } as never;
      next();
    });
    app.use(createArtifactoryRouter(api));

    // Hand-rolled multipart: superagent's .attach() basenames the filename, which
    // is exactly the behaviour under test.
    const boundary = "----portaltest";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="folderName"\r\n\r\nnode_modules\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="node_modules/arg/package.json"\r\n` +
      `Content-Type: application/json\r\n\r\n{}\r\n--${boundary}--\r\n`;

    await request(app)
      .post("/api/artifactory/jobs/folder-upload")
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(body)
      .expect(201);

    // busboy basenames every part unless multer gets `preservePath` — without it
    // every package.json collides and only one package survives the upload.
    expect(received?.files?.[0].originalname).toBe("node_modules/arg/package.json");
  });
});
