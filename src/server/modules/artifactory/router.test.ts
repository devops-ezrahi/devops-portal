import { readFile } from "fs/promises";
import { dirname } from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { removeTmpDir } from "../../tmp";
import { createArtifactoryRouter } from "./router";
import type { ArtifactoryApi, FolderUploadInput } from "../../types";

vi.mock("../../auth", () => ({ isAdmin: () => false }));

function appWith(api: ArtifactoryApi) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: "dev" } as never;
    next();
  });
  app.use(createArtifactoryRouter(api));
  return app;
}

describe("folder-upload route", () => {
  it("streams the archive to disk and hands the job its path", async () => {
    let received: FolderUploadInput | undefined;
    const api = {
      async submitFolderUpload(input: FolderUploadInput) {
        received = input;
        return { id: "ART-0001" };
      },
    } as unknown as ArtifactoryApi;

    const archive = Buffer.from("PK pretend zip");
    await request(appWith(api))
      .post("/api/artifactory/jobs/folder-upload")
      .field("folderName", "node_modules")
      .field("fileCount", "3")
      .field("totalBytes", "1234")
      .attach("archive", archive, "archive.zip")
      .expect(201);

    // The job is handed a path, never a Buffer: multer must not be holding a
    // second full-size copy of the upload in the heap.
    expect(received?.folderName).toBe("node_modules");
    expect(received?.fileCount).toBe(3);
    expect(received?.totalBytes).toBe(1234);
    expect(await readFile(received!.archivePath)).toEqual(archive);

    await removeTmpDir(dirname(received!.archivePath));
  });

  it("rejects a request with no archive instead of starting a job", async () => {
    const submitFolderUpload = vi.fn();
    const app = appWith({ submitFolderUpload } as unknown as ArtifactoryApi);

    await request(app)
      .post("/api/artifactory/jobs/folder-upload")
      .field("folderName", "node_modules")
      .expect(400);

    expect(submitFolderUpload).not.toHaveBeenCalled();
  });
});
