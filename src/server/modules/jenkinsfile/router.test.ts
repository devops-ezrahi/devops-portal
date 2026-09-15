import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Its own volume per app, so ids always start at JF-0001. */
async function appOn(dataDir: string) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  vi.doMock("../../config", () => ({ config: { ...actual.config, dataDir } }));
  const { createApp } = await import("../../app");
  return createApp();
}

const alex = { "x-user-id": "u-alex", "x-user-name": "Alex Morgan", "x-user-groups": "developers" };
const sam = { "x-user-id": "u-sam", "x-user-name": "Sam Reed", "x-user-groups": "developers" };
const admin = { "x-user-id": "u-root", "x-user-name": "Root", "x-user-groups": "portal-admins" };

/** No name: the server mints one from the author. */
const body = {
  library: "jenkins-k8s-shared-library",
  envVars: { SERVICE: "checkout" },
  params: [],
  stages: [{ id: "s-1", step: "semVerStage", args: {}, collapsed: true }],
};

afterEach(() => {
  vi.doUnmock("../../config");
  vi.resetModules();
});

describe("jenkinsfile pipelines", () => {
  it("saves a pipeline, stamps the owner and lists it back to them alone", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));

    const created = await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);
    expect(created.body.pipeline).toMatchObject({ id: "JF-0001", name: "Alex Morgan #1", createdBy: "u-alex" });

    const mine = await request(app).get("/api/jenkinsfile/pipelines").set(alex).expect(200);
    expect(mine.body.pipelines).toHaveLength(1);

    const theirs = await request(app).get("/api/jenkinsfile/pipelines").set(sam).expect(200);
    expect(theirs.body.pipelines).toEqual([]);

    const all = await request(app).get("/api/jenkinsfile/pipelines").set(admin).expect(200);
    expect(all.body.pipelines).toHaveLength(1);
  });

  it("keeps someone else out, but lets an admin in without taking the pipeline over", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);

    await request(app).get("/api/jenkinsfile/pipelines/JF-0001").set(sam).expect(403);
    await request(app).put("/api/jenkinsfile/pipelines/JF-0001").set(sam).send(body).expect(403);
    await request(app).delete("/api/jenkinsfile/pipelines/JF-0001").set(sam).expect(403);

    const edited = await request(app)
      .put("/api/jenkinsfile/pipelines/JF-0001")
      .set(admin)
      .send({ ...body, library: "jenkins-k8s-shared-library@dev" })
      .expect(200);
    // The name belongs to whoever made it — an admin editing it takes neither.
    expect(edited.body.pipeline).toMatchObject({
      name: "Alex Morgan #1",
      library: "jenkins-k8s-shared-library@dev",
      createdBy: "u-alex",
    });
  });

  it("404s an unknown id and 400s a body the builder could not have sent", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));

    await request(app).get("/api/jenkinsfile/pipelines/JF-9999").set(alex).expect(404);
    await request(app).put("/api/jenkinsfile/pipelines/JF-9999").set(alex).send(body).expect(404);
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send({ ...body, envVars: "no" }).expect(400);
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send({ ...body, stages: [{}] }).expect(400);
  });

  it("numbers each author's pipelines separately, and reuses a number once freed", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));

    const first = await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);
    const second = await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);
    const theirs = await request(app).post("/api/jenkinsfile/pipelines").set(sam).send(body).expect(201);

    expect(first.body.pipeline.name).toBe("Alex Morgan #1");
    expect(second.body.pipeline.name).toBe("Alex Morgan #2");
    expect(theirs.body.pipeline.name).toBe("Sam Reed #1");

    await request(app).delete(`/api/jenkinsfile/pipelines/${first.body.pipeline.id}`).set(alex).expect(200);
    const third = await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);
    expect(third.body.pipeline.name).toBe("Alex Morgan #1");
  });

  it("takes a name on create, and renames on update", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));

    const named = await request(app)
      .post("/api/jenkinsfile/pipelines")
      .set(alex)
      .send({ ...body, name: "  Checkout release  " })
      .expect(201);
    expect(named.body.pipeline.name).toBe("Checkout release");

    const renamed = await request(app)
      .put("/api/jenkinsfile/pipelines/JF-0001")
      .set(alex)
      .send({ ...body, name: "Checkout nightly" })
      .expect(200);
    expect(renamed.body.pipeline.name).toBe("Checkout nightly");
  });

  it("keeps the stored name when the field is blank, rather than emptying the list row", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);

    const kept = await request(app)
      .put("/api/jenkinsfile/pipelines/JF-0001")
      .set(alex)
      .send({ ...body, name: "   " })
      .expect(200);
    expect(kept.body.pipeline.name).toBe("Alex Morgan #1");
  });

  it("keeps a stage's minimized flag, so a pipeline opens the way it was left", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    const created = await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);
    expect(created.body.pipeline.stages[0].collapsed).toBe(true);
  });

  it("accepts a pipeline with no @Library line, and names the configured one on the list", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send({ ...body, library: "" }).expect(201);

    const listed = await request(app).get("/api/jenkinsfile/pipelines").set(alex).expect(200);
    expect(listed.body.pipelines[0].library).toBe("");
    expect(listed.body.sharedLibrary).toBe("jenkins-k8s-shared-library");
  });

  it("really deletes — these are documents, not job history", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);

    await request(app).delete("/api/jenkinsfile/pipelines/JF-0001").set(alex).expect(200);
    await request(app).get("/api/jenkinsfile/pipelines/JF-0001").set(alex).expect(404);
    const after = await request(app).get("/api/jenkinsfile/pipelines").set(alex).expect(200);
    expect(after.body.pipelines).toEqual([]);
  });

  it("stores the connected repository, normalising the SSH URL on the way in", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    const created = await request(app)
      .post("/api/jenkinsfile/pipelines")
      .set(alex)
      // What a git host's Clone button gives you. The portal holds a token, not
      // a key, so it is rewritten here rather than failing three screens later.
      .send({ ...body, repo: { repoUrl: "git@github.com:org/svc.git", revision: "main", path: "ci/Jenkinsfile" } })
      .expect(201);
    expect(created.body.pipeline.repo).toEqual({
      repoUrl: "https://github.com/org/svc.git",
      revision: "main",
      path: "ci/Jenkinsfile",
    });

    // An update that says nothing about the repo leaves the connection alone —
    // losing it would silently turn Commit into a dead button.
    const kept = await request(app).put("/api/jenkinsfile/pipelines/JF-0001").set(alex).send(body).expect(200);
    expect(kept.body.pipeline.repo.path).toBe("ci/Jenkinsfile");
  });

  it("refuses to be pointed at anything but an http(s) repository", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));

    // `ext::` is git's shell transport — its "URL" is a command git runs.
    await request(app)
      .post("/api/jenkinsfile/pull")
      .set(alex)
      .send({ repoUrl: "ext::sh -c 'curl evil'", revision: "main", path: "" })
      .expect(400);
    await request(app)
      .post("/api/jenkinsfile/pull")
      .set(alex)
      .send({ repoUrl: "https://github.com/o/r.git", revision: "--upload-pack=x", path: "" })
      .expect(400);
    await request(app)
      .post("/api/jenkinsfile/pull")
      .set(alex)
      .send({ repoUrl: "https://github.com/o/r.git", revision: "main", path: "../../etc/passwd" })
      .expect(400);
  });

  it("will not push a pipeline that is not connected, or someone else's", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "jf-test-")));
    await request(app).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);

    // Connected to nothing: the destination is the record's, so there is none.
    await request(app)
      .post("/api/jenkinsfile/pipelines/JF-0001/push")
      .set(alex)
      .send({ text: "genStage()\n" })
      .expect(400);
    await request(app).post("/api/jenkinsfile/pipelines/JF-0001/push").set(sam).send({ text: "x" }).expect(403);
    await request(app).post("/api/jenkinsfile/pipelines/JF-9999/push").set(alex).send({ text: "x" }).expect(404);
  });

  it("survives a restart and does not reuse the id it already handed out", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jf-test-"));
    const first = await appOn(dataDir);
    await request(first).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);

    const second = await appOn(dataDir);
    const listed = await request(second).get("/api/jenkinsfile/pipelines").set(alex).expect(200);
    expect(listed.body.pipelines).toMatchObject([{ id: "JF-0001", name: "Alex Morgan #1" }]);

    const next = await request(second).post("/api/jenkinsfile/pipelines").set(alex).send(body).expect(201);
    expect(next.body.pipeline.id).toBe("JF-0002");
  });
});
