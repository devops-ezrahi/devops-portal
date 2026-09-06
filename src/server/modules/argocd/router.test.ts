import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Its own volume per app, so ids always start at AG-0001. */
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
  chart: { repoUrl: "https://github.com/devops-ezrahi/universal-chart.git", path: ".", revision: "main" },
  values: { repoUrl: "https://git.example.com/gitops/values.git", revision: "main", path: "" },
  rootAppName: "platform-root",
  releases: [{ id: "r1", name: "api-gateway", features: { image: { on: true, v: { repository: "nginx" } } } }],
  namespaces: [{ name: "shop-web", releases: [{ release: "r1", features: {} }] }],
};

afterEach(() => {
  vi.doUnmock("../../config");
  vi.resetModules();
});

describe("argocd trees", () => {
  it("saves a tree, stamps the owner and lists it back to them alone", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "ag-test-")));

    const created = await request(app).post("/api/argocd/trees").set(alex).send(body).expect(201);
    expect(created.body.tree).toMatchObject({ id: "AG-0001", name: "Alex Morgan #1", createdBy: "u-alex" });

    const mine = await request(app).get("/api/argocd/trees").set(alex).expect(200);
    expect(mine.body.trees).toHaveLength(1);
    // The chart/values repo defaults ride along on the list the view fetches.
    expect(mine.body.defaults.chartRepoUrl).toContain("universal-chart");

    expect((await request(app).get("/api/argocd/trees").set(sam).expect(200)).body.trees).toEqual([]);
    expect((await request(app).get("/api/argocd/trees").set(admin).expect(200)).body.trees).toHaveLength(1);
  });

  it("keeps someone else out, but lets an admin in without taking the tree over", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "ag-test-")));
    await request(app).post("/api/argocd/trees").set(alex).send(body).expect(201);

    await request(app).get("/api/argocd/trees/AG-0001").set(sam).expect(403);
    await request(app).put("/api/argocd/trees/AG-0001").set(sam).send(body).expect(403);
    await request(app).delete("/api/argocd/trees/AG-0001").set(sam).expect(403);

    const edited = await request(app)
      .put("/api/argocd/trees/AG-0001")
      .set(admin)
      .send({ ...body, name: "Renamed" })
      .expect(200);
    expect(edited.body.tree).toMatchObject({ name: "Renamed", createdBy: "u-alex", createdByName: "Alex Morgan" });
  });

  it("numbers per author and reuses a freed number", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "ag-test-")));
    await request(app).post("/api/argocd/trees").set(alex).send(body).expect(201);
    await request(app).post("/api/argocd/trees").set(alex).send(body).expect(201);
    const theirs = await request(app).post("/api/argocd/trees").set(sam).send(body).expect(201);
    expect(theirs.body.tree.name).toBe("Sam Reed #1");

    await request(app).delete("/api/argocd/trees/AG-0001").set(alex).expect(200);
    const next = await request(app).post("/api/argocd/trees").set(alex).send(body).expect(201);
    expect(next.body.tree).toMatchObject({ id: "AG-0004", name: "Alex Morgan #1" });
  });

  it("keeps the stored name when the body's is blank", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "ag-test-")));
    await request(app).post("/api/argocd/trees").set(alex).send({ ...body, name: "Platform" }).expect(201);
    const updated = await request(app)
      .put("/api/argocd/trees/AG-0001")
      .set(alex)
      .send({ ...body, name: "  " })
      .expect(200);
    expect(updated.body.tree.name).toBe("Platform");
  });

  it("rejects a body the builder could not have sent", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "ag-test-")));
    await request(app).post("/api/argocd/trees").set(alex).send({ ...body, releases: [{ name: "no-id" }] }).expect(400);
  });

  it("survives a restart and resumes ids past the highest on disk", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ag-test-"));
    const first = await appOn(dataDir);
    await request(first).post("/api/argocd/trees").set(alex).send(body).expect(201);

    const second = await appOn(dataDir);
    const list = await request(second).get("/api/argocd/trees").set(alex).expect(200);
    expect(list.body.trees[0].id).toBe("AG-0001");
    const next = await request(second).post("/api/argocd/trees").set(alex).send(body).expect(201);
    expect(next.body.tree.id).toBe("AG-0002");
  });

  it("404s on a tree that is not there", async () => {
    const app = await appOn(mkdtempSync(join(tmpdir(), "ag-test-")));
    await request(app).get("/api/argocd/trees/AG-9999").set(alex).expect(404);
    await request(app).delete("/api/argocd/trees/AG-9999").set(alex).expect(404);
  });
});
