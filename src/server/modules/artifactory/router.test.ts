import { readFile } from "fs/promises";
import { dirname } from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { removeTmpDir } from "../../tmp";
import { createArtifactoryRouter } from "./router";
import type { ArtifactoryApi, FolderUploadInput, UrlCopyInput } from "../../types";

vi.mock("../../auth", () => ({ isAdmin: () => false }));

function appWith(api: ArtifactoryApi) {
  const app = express();
  // Mirrors app.ts, which mounts the JSON parser ahead of every module router.
  app.use(express.json());
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

describe("url-copy route", () => {
  function urlCopyApp() {
    const submitUrlCopy = vi.fn(async (_input: UrlCopyInput) => ({ id: "ART-0001" }));
    return {
      submitUrlCopy,
      app: appWith({ submitUrlCopy } as unknown as ArtifactoryApi),
    };
  }

  it("carries includeDependencies through to the job", async () => {
    const { submitUrlCopy, app } = urlCopyApp();

    await request(app)
      .post("/api/artifactory/jobs/url-copy")
      .send({ sourceUrl: "https://registry.npmjs.org/arg/-/arg-4.1.5.tgz", includeDependencies: true })
      .expect(201);

    expect(submitUrlCopy.mock.calls[0][0].includeDependencies).toBe(true);
  });

  it("leaves it undefined when the box was not ticked", async () => {
    const { submitUrlCopy, app } = urlCopyApp();

    await request(app)
      .post("/api/artifactory/jobs/url-copy")
      .send({ sourceUrl: "https://registry.npmjs.org/arg/-/arg-4.1.5.tgz" })
      .expect(201);

    expect(submitUrlCopy.mock.calls[0][0].includeDependencies).toBeUndefined();
  });

  it("rejects a non-boolean rather than coercing it", async () => {
    const { submitUrlCopy, app } = urlCopyApp();

    await request(app)
      .post("/api/artifactory/jobs/url-copy")
      .send({ sourceUrl: "https://registry.npmjs.org/arg/-/arg-4.1.5.tgz", includeDependencies: "yes" })
      .expect((res) => {
        if (res.status < 400) throw new Error(`expected a 4xx/5xx, got ${res.status}`);
      });

    expect(submitUrlCopy).not.toHaveBeenCalled();
  });
});
