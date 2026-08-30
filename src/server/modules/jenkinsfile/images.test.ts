import { afterEach, describe, expect, it, vi } from "vitest";

const config = {
  artifactory: { url: "https://art.example.com", repo: "npm-local", token: "art-token", enabled: true },
  jenkinsfile: { sharedLibrary: "lib", imagesPath: "docker-local/agents" },
  ssoRequired: true,
  git: { token: "" },
  ai: { apiKey: "" },
};

vi.mock("../../config", () => ({ config }));

const { pickableImages, resetImageCache } = await import("./images");

function stubAql(results: unknown[], ok = true) {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 403, statusText: "", json: async () => ({ results }), text: async () => "" }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetImageCache();
  config.artifactory.enabled = true;
  config.jenkinsfile.imagesPath = "docker-local/agents";
  config.ssoRequired = true;
});

describe("pickableImages", () => {
  it("renders each image's labels as one info line, sorted by label", async () => {
    stubAql([
      {
        path: "agents/python311/1.0",
        properties: [
          { key: "docker.label.PY", value: "3.11" },
          { key: "docker.label.JDK", value: "17" },
        ],
      },
    ]);
    expect(await pickableImages()).toEqual([{ name: "python311", info: "JDK=17 · PY=3.11" }]);
  });

  it("leaves the info blank for an image with no labels", async () => {
    stubAql([{ path: "agents/ubi8/1.0", properties: [] }]);
    expect(await pickableImages()).toEqual([{ name: "ubi8", info: "" }]);
  });

  it("asks Artifactory once and serves the rest from cache", async () => {
    const fetchMock = stubAql([{ path: "agents/ubi8/1.0", properties: [] }]);
    await pickableImages();
    await pickableImages();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call Artifactory at all when no path is configured", async () => {
    config.jenkinsfile.imagesPath = "";
    const fetchMock = stubAql([]);
    expect(await pickableImages()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Artifactory when it is not configured", async () => {
    config.artifactory.enabled = false;
    const fetchMock = stubAql([]);
    expect(await pickableImages()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The picker is invisible offline without this — there is no Artifactory
  // behind `npm run dev` to suggest anything.
  it("falls back to the scripted list in dev when there is nothing real to ask", async () => {
    config.ssoRequired = false;
    config.jenkinsfile.imagesPath = "";
    const fetchMock = stubAql([]);
    const images = await pickableImages();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(images.map((i) => i.name)).toContain("python311");
    expect(images.find((i) => i.name === "sonar")?.info).toBe("JDK=17 · SONAR=10.4");
  });

  it("never serves the scripted list once SSO is required", async () => {
    config.ssoRequired = true;
    config.jenkinsfile.imagesPath = "";
    expect(await pickableImages()).toEqual([]);
  });

  // A configured Artifactory is the real thing and must win, even in dev.
  it("prefers a real lookup over the scripted list", async () => {
    config.ssoRequired = false;
    stubAql([{ path: "agents/only-real/1.0", properties: [] }]);
    expect(await pickableImages()).toEqual([{ name: "only-real", info: "" }]);
  });

  // Otherwise one bad response pins the picker empty for the whole TTL.
  it("does not cache a failed lookup", async () => {
    const failing = stubAql([], false);
    expect(await pickableImages()).toEqual([]);
    expect(failing).toHaveBeenCalledTimes(1);

    const working = stubAql([{ path: "agents/ubi8/1.0", properties: [] }]);
    expect(await pickableImages()).toEqual([{ name: "ubi8", info: "" }]);
    expect(working).toHaveBeenCalledTimes(1);
  });
});
