import { afterEach, describe, expect, it, vi } from "vitest";

const config = {
  artifactory: { url: "https://art.example.com", repo: "npm-local", token: "art-token" },
};

vi.mock("../../config", () => ({ config }));

const { exists, serviceUrl, webUrl } = await import("./artifactoryRest");

afterEach(() => {
  vi.unstubAllGlobals();
  config.artifactory.url = "https://art.example.com";
  config.artifactory.token = "art-token";
});

describe("serviceUrl", () => {
  it("appends /artifactory to a platform base URL", () => {
    expect(serviceUrl()).toBe("https://art.example.com/artifactory");
  });

  it("leaves a service URL that already has it alone", () => {
    config.artifactory.url = "https://art.example.com/artifactory";
    expect(serviceUrl()).toBe("https://art.example.com/artifactory");
  });

  it("names the missing env vars when unconfigured", () => {
    config.artifactory.token = "";
    expect(() => serviceUrl()).toThrow(/ARTIFACTORY_URL and ARTIFACTORY_TOKEN/);
  });
});

describe("webUrl", () => {
  it("builds a UI tree link from the platform base URL", () => {
    expect(webUrl("npm-local/arg/-/arg-4.1.5.tgz")).toBe(
      "https://art.example.com/ui/tree/General/npm-local/arg/-/arg-4.1.5.tgz"
    );
  });

  it("strips a trailing /artifactory so the link is not doubled up", () => {
    config.artifactory.url = "https://art.example.com/artifactory";
    expect(webUrl("npm-local/arg")).toBe("https://art.example.com/ui/tree/General/npm-local/arg");
  });
});

describe("exists", () => {
  function stubFetch(response: Partial<Response> | Error) {
    const fn = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response as Response;
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("sends an authenticated HEAD to the service URL", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    await exists("npm-local/arg/-/arg-4.1.5.tgz");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://art.example.com/artifactory/npm-local/arg/-/arg-4.1.5.tgz",
      { method: "HEAD", headers: { Authorization: "Bearer art-token" } }
    );
  });

  it("reports a present artifact", async () => {
    stubFetch({ ok: true, status: 200 });
    expect(await exists("npm-local/arg")).toBe(true);
  });

  it("reports an absent artifact", async () => {
    stubFetch({ ok: false, status: 404 });
    expect(await exists("npm-local/arg")).toBe(false);
  });

  it("returns null on 403 so a read-permission gap never reads as 'already uploaded'", async () => {
    stubFetch({ ok: false, status: 403 });
    expect(await exists("npm-local/arg")).toBeNull();
  });

  it("returns null when the request cannot be made at all", async () => {
    stubFetch(new Error("ECONNREFUSED"));
    expect(await exists("npm-local/arg")).toBeNull();
  });
});
