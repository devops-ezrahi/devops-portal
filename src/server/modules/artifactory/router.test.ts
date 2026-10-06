import { Readable, Writable } from "stream";
import { pipeline } from "stream/promises";
import { readFile } from "fs/promises";
import { dirname } from "path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { removeTmpDir, tmpDirByName } from "../../tmp";
import { byteLimit, createArtifactoryRouter, UploadTooLargeError } from "./router";
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
  async function beginUpload(app: express.Express): Promise<string> {
    const res = await request(app).post("/api/artifactory/uploads").expect(201);
    return res.body.uploadId as string;
  }

  function putPart(app: express.Express, id: string, offset: number, body: Buffer) {
    return request(app)
      .put(`/api/artifactory/uploads/${id}`)
      .query({ offset })
      .set("Content-Type", "application/octet-stream")
      .send(body);
  }

  it("writes each part at its offset and hands the job the finished archive", async () => {
    let received: FolderUploadInput | undefined;
    const api = {
      async submitFolderUpload(input: FolderUploadInput) {
        received = input;
        return { id: "ART-0001" };
      },
    } as unknown as ArtifactoryApi;
    const app = appWith(api);

    const first = Buffer.from("PK pretend ");
    const second = Buffer.from("zip");
    const uploadId = await beginUpload(app);

    // Backwards on purpose: parts travel several at a time, so the tail can land
    // before the head. The offset each carries is what puts the archive back
    // together, not the order they arrived in.
    await putPart(app, uploadId, first.length, second).expect(200);
    await putPart(app, uploadId, 0, first).expect(200);

    await request(app)
      .post("/api/artifactory/jobs/folder-upload")
      .send({
        uploadId,
        folderName: "node_modules",
        fileCount: 3,
        totalBytes: 1234,
        archiveBytes: first.length + second.length,
      })
      .expect(201);

    // The job is handed a path, never a Buffer: no part of this upload was ever
    // held in the heap, at either end.
    expect(received?.folderName).toBe("node_modules");
    expect(received?.fileCount).toBe(3);
    expect(received?.totalBytes).toBe(1234);
    expect(await readFile(received!.archivePath)).toEqual(Buffer.concat([first, second]));

    await removeTmpDir(dirname(received!.archivePath));
  });

  // The offset is a number off the wire that becomes a file position, so it is
  // checked rather than trusted. A missing one used to be refused only as a side
  // effect of the ordering rule this replaces (`Number(undefined)` is `NaN`).
  it("refuses an offset that is not a whole non-negative number", async () => {
    const app = appWith({} as ArtifactoryApi);
    const uploadId = await beginUpload(app);

    await request(app)
      .put(`/api/artifactory/uploads/${uploadId}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("abc"))
      .expect(400);
    await putPart(app, uploadId, -1, Buffer.from("abc")).expect(400);
    await putPart(app, uploadId, 1.5, Buffer.from("abc")).expect(400);

    await removeTmpDir(tmpDirByName(uploadId));
  });

  // A part that never landed leaves a hole or a short file, which reaches the
  // job as a corrupt zip minutes later. The client says how big the archive is;
  // the file says how big it actually is.
  it("refuses to complete when the archive is short of what was sent", async () => {
    const submitFolderUpload = vi.fn();
    const app = appWith({ submitFolderUpload } as unknown as ArtifactoryApi);
    const uploadId = await beginUpload(app);

    await putPart(app, uploadId, 0, Buffer.from("PK pretend zip")).expect(200);

    await request(app)
      .post("/api/artifactory/jobs/folder-upload")
      .send({
        uploadId,
        folderName: "node_modules",
        fileCount: 3,
        totalBytes: 1234,
        archiveBytes: 999,
      })
      .expect(400);

    expect(submitFolderUpload).not.toHaveBeenCalled();
  });

  it("rejects an id that never opened an upload", async () => {
    const app = appWith({} as ArtifactoryApi);

    await putPart(app, "art-00000000-0000-4000-8000-000000000000", 0, Buffer.from("x")).expect(404);
    // Percent-encoded so it survives as one path segment: Express decodes it
    // back into the param, and the id is checked before it becomes a path.
    await putPart(app, "..%2F..%2Fetc", 0, Buffer.from("x")).expect(400);
  });

  it("rejects completing an upload that carries no bytes", async () => {
    const submitFolderUpload = vi.fn();
    const app = appWith({ submitFolderUpload } as unknown as ArtifactoryApi);
    const uploadId = await beginUpload(app);

    await request(app)
      .post("/api/artifactory/jobs/folder-upload")
      .send({ uploadId, folderName: "node_modules", fileCount: 0, totalBytes: 0, archiveBytes: 1 })
      .expect(400);

    expect(submitFolderUpload).not.toHaveBeenCalled();
  });
});

// The size cap is the one thing here that cannot be exercised through the route
// without pushing half a gigabyte through the test suite. It failed open once
// already: a `data` listener that destroyed the request let `pipeline` resolve,
// so the oversized part was answered "200 OK" and kept.
describe("byteLimit", () => {
  async function through(limit: number, chunks: string[]) {
    const out: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _e, cb) {
        out.push(chunk);
        cb();
      },
    });
    await pipeline(Readable.from(chunks.map((c) => Buffer.from(c))), byteLimit(limit), sink);
    return Buffer.concat(out).toString();
  }

  it("passes a stream that stays under the limit through untouched", async () => {
    expect(await through(10, ["abc", "de"])).toBe("abcde");
  });

  it("fails the stream once the limit is passed", async () => {
    await expect(through(4, ["abc", "de"])).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  it("counts the bytes already on disk, not just this part", async () => {
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    await expect(
      pipeline(Readable.from([Buffer.from("abc")]), byteLimit(4, 3), sink)
    ).rejects.toBeInstanceOf(UploadTooLargeError);
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
