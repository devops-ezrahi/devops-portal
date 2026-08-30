import { afterEach, describe, expect, it, vi } from "vitest";

const config = {
  artifactory: { url: "https://art.example.com", repo: "npm-local", token: "art-token" },
  // The log lines here run through redactSecrets, which reads all three tokens.
  git: { token: "" },
  ai: { apiKey: "" },
};

vi.mock("../../config", () => ({ config }));

const { exists, listImages, serviceUrl, webUrl, nativeUrl } = await import("./artifactoryRest");

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
      "https://art.example.com/ui/repos/tree/General/npm-local/arg/-/arg-4.1.5.tgz"
    );
  });

  it("strips a trailing /artifactory so the link is not doubled up", () => {
    config.artifactory.url = "https://art.example.com/artifactory";
    expect(webUrl("npm-local/arg")).toBe("https://art.example.com/ui/repos/tree/General/npm-local/arg");
  });
});

describe("nativeUrl", () => {
  it("builds a UI native package link from the platform base URL", () => {
    expect(nativeUrl("maven-local/com/google/guava/guava/32.1.3-jre/guava-32.1.3-jre.pom")).toBe(
      "https://art.example.com/ui/native/maven-local/com/google/guava/guava/32.1.3-jre/guava-32.1.3-jre.pom"
    );
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

describe("listImages", () => {
  function stubAql(body: unknown, ok = true) {
    const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 403, statusText: "", json: async () => body, text: async () => "" }) as unknown as Response);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("posts one AQL query scoped to the configured path", async () => {
    const fetchMock = stubAql({ results: [] });
    await listImages("docker-local/agents");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://art.example.com/artifactory/api/search/aql");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer art-token");
    // Open-ended depth: the names sit directly under the configured path in one
    // layout and one level further down in another.
    expect(init.body).toContain('"path":{"$match":"agents/*"}');
    expect(init.body).toContain('"repo":"docker-local"');
  });

  it("names each image after the segment under the configured path, keeping only SCREAMING_CASE labels", async () => {
    stubAql({
      results: [
        {
          path: "agents/python311/1.0",
          properties: [
            { key: "docker.label.PY", value: "3.11" },
            { key: "docker.label.JDK", value: "17" },
            { key: "docker.label.org.opencontainers.image.source", value: "https://example.com" },
            { key: "sha256", value: "abc" },
          ],
        },
      ],
    });
    expect(await listImages("docker-local/agents")).toEqual([
      { name: "python311", labels: { JDK: "17", PY: "3.11" } },
    ]);
  });

  it("merges the tags of one image into a single entry, sorted by name", async () => {
    stubAql({
      results: [
        { path: "ubi8/2.0", properties: [{ key: "docker.label.OS", value: "rhel8" }] },
        { path: "ubi8/1.0", properties: [{ key: "docker.label.JDK", value: "11" }] },
        { path: "mvn353/1.0", properties: [] },
      ],
    });
    expect(await listImages("docker-local")).toEqual([
      { name: "mvn353", labels: {} },
      { name: "ubi8", labels: { JDK: "11", OS: "rhel8" } },
    ]);
  });

  it("returns null rather than an empty list when the search is refused", async () => {
    stubAql({}, false);
    expect(await listImages("docker-local")).toBeNull();
  });

  it("returns null when the response has no results array", async () => {
    stubAql({ errors: [{ status: 400 }] });
    expect(await listImages("docker-local")).toBeNull();
  });
});
