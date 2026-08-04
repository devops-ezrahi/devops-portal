import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The demo jobs must never reach a deployment. `app.ts` reads the gate once at
 * module load, so each case needs its own module registry.
 */
async function jobsWithSso(ssoRequired: boolean) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("./config")>("./config");
  vi.doMock("./config", () => ({ config: { ...actual.config, ssoRequired } }));

  const { createApp } = await import("./app");
  const app = createApp();

  const headers = { "x-user-id": "u-alex", "x-user-groups": "portal-admins" };
  const artifactory = await request(app).get("/api/artifactory/jobs").set(headers).expect(200);
  const whitening = await request(app).get("/api/whitening/jobs").set(headers).expect(200);
  return { artifactory: artifactory.body.jobs, whitening: whitening.body.jobs };
}

afterEach(() => {
  vi.doUnmock("./config");
  vi.resetModules();
});

describe("dev demo jobs", () => {
  it("are seeded when no SSO proxy is in front", async () => {
    const { artifactory, whitening } = await jobsWithSso(false);
    expect(artifactory.map((j: { id: string }) => j.id)).toEqual(["ART-0001", "ART-0002"]);
    expect(whitening.map((j: { id: string }) => j.id)).toEqual(["WHT-0001", "WHT-0002"]);
  });

  it("are absent once SSO is required", async () => {
    const { artifactory, whitening } = await jobsWithSso(true);
    expect(artifactory).toEqual([]);
    expect(whitening).toEqual([]);
  });
});
