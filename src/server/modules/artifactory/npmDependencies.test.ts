import { describe, expect, it } from "vitest";
import {
  npmAuthKey,
  npmIdentityFromUrl,
  npmRegistryFromUrl,
  npmrcContents,
  packageSpec,
  sourceTokenFor,
  supportsPlatformFlags,
} from "./npmDependencies";

describe("npmRegistryFromUrl", () => {
  it("takes the registry off a public npmjs tarball", () => {
    expect(npmRegistryFromUrl("https://registry.npmjs.org/arg/-/arg-4.1.5.tgz")).toBe(
      "https://registry.npmjs.org"
    );
  });

  it("drops both name segments for a scoped package", () => {
    expect(npmRegistryFromUrl("https://registry.npmjs.org/@babel/core/-/core-7.24.0.tgz")).toBe(
      "https://registry.npmjs.org"
    );
  });

  // Artifactory serves the bytes at /artifactory/<repo>, but npm asking there
  // gets the HTML UI back — "Unexpected token '<'". The API endpoint is the fix.
  it("rewrites an Artifactory storage path to the npm API endpoint", () => {
    expect(
      npmRegistryFromUrl(
        "https://artifactory.app.iaf/artifactory/matas-npm-dev-local/@ewoudenberg/difflib/-/difflib-0.1.0.tgz"
      )
    ).toBe("https://artifactory.app.iaf/artifactory/api/npm/matas-npm-dev-local");
  });

  it("keeps the base path of an Artifactory npm remote", () => {
    expect(
      npmRegistryFromUrl("https://af.example.com/artifactory/api/npm/npm-remote/arg/-/arg-4.1.5.tgz")
    ).toBe("https://af.example.com/artifactory/api/npm/npm-remote");
  });

  // The case a naive "strip two segments" implementation gets wrong.
  it("keeps the base path for a scoped package on an Artifactory remote", () => {
    expect(
      npmRegistryFromUrl(
        "https://af.example.com/artifactory/api/npm/npm-remote/@babel/core/-/core-7.24.0.tgz"
      )
    ).toBe("https://af.example.com/artifactory/api/npm/npm-remote");
  });

  it("keeps a non-default port", () => {
    expect(npmRegistryFromUrl("http://localhost:8081/repo/arg/-/arg-4.1.5.tgz")).toBe(
      "http://localhost:8081/repo"
    );
  });

  it("ignores a query string", () => {
    expect(npmRegistryFromUrl("https://registry.npmjs.org/arg/-/arg-4.1.5.tgz?dl=1")).toBe(
      "https://registry.npmjs.org"
    );
  });

  it("takes the last /-/ so a base path containing one cannot shadow it", () => {
    expect(npmRegistryFromUrl("https://af.example.com/-/npm/arg/-/arg-4.1.5.tgz")).toBe(
      "https://af.example.com/-/npm"
    );
  });

  it("returns null for a GitHub release tarball", () => {
    expect(
      npmRegistryFromUrl("https://github.com/owner/repo/archive/refs/tags/v1.0.0.tar.gz")
    ).toBeNull();
  });

  it("returns null when the marker is not second-to-last", () => {
    expect(npmRegistryFromUrl("https://registry.npmjs.org/arg/-/nested/arg-4.1.5.tgz")).toBeNull();
  });

  it("returns null when there is no package name before the marker", () => {
    expect(npmRegistryFromUrl("https://registry.npmjs.org/-/arg-4.1.5.tgz")).toBeNull();
  });

  it("returns null for a non-http URL or garbage", () => {
    expect(npmRegistryFromUrl("file:///tmp/arg/-/arg-4.1.5.tgz")).toBeNull();
    expect(npmRegistryFromUrl("not a url")).toBeNull();
  });
});

describe("npmAuthKey", () => {
  it("drops the protocol and keeps a trailing slash", () => {
    expect(npmAuthKey("https://registry.npmjs.org")).toBe("//registry.npmjs.org/");
  });

  it("keeps a base path", () => {
    expect(npmAuthKey("https://af.example.com/artifactory/api/npm/npm-remote")).toBe(
      "//af.example.com/artifactory/api/npm/npm-remote/"
    );
  });

  it("does not double a trailing slash already on the input", () => {
    expect(npmAuthKey("https://af.example.com/repo/")).toBe("//af.example.com/repo/");
  });

  it("keeps a non-default port", () => {
    expect(npmAuthKey("http://localhost:8081/repo")).toBe("//localhost:8081/repo/");
  });
});

describe("npmrcContents", () => {
  it("writes the auth line when a token is given", () => {
    expect(npmrcContents("https://af.example.com/repo", "secret")).toBe(
      "registry=https://af.example.com/repo\n//af.example.com/repo/:_authToken=secret\n"
    );
  });

  it("writes registry alone when there is no token", () => {
    const contents = npmrcContents("https://registry.npmjs.org", "");
    expect(contents).toBe("registry=https://registry.npmjs.org\n");
    expect(contents).not.toContain("_authToken");
  });
});

describe("sourceTokenFor", () => {
  it("reuses the Artifactory token when the source is the same host", () => {
    expect(
      sourceTokenFor(
        "https://af.example.com/artifactory/api/npm/npm-remote",
        "https://af.example.com/artifactory",
        "art-token",
        ""
      )
    ).toBe("art-token");
  });

  it("uses the explicit source token for a different host", () => {
    expect(
      sourceTokenFor("https://registry.npmjs.org", "https://af.example.com", "art-token", "npm-token")
    ).toBe("npm-token");
  });

  it("is anonymous when neither applies", () => {
    expect(sourceTokenFor("https://registry.npmjs.org", "https://af.example.com", "art-token", "")).toBe(
      ""
    );
  });

  it("falls back to the source token when ARTIFACTORY_URL is unusable", () => {
    expect(sourceTokenFor("https://registry.npmjs.org", "not a url", "art-token", "npm-token")).toBe(
      "npm-token"
    );
  });
});

describe("supportsPlatformFlags", () => {
  it("rejects npm older than 9.7.0", () => {
    expect(supportsPlatformFlags("9.2.0")).toBe(false);
    expect(supportsPlatformFlags("9.6.7")).toBe(false);
    expect(supportsPlatformFlags("8.19.4")).toBe(false);
  });

  it("accepts 9.7.0 and later", () => {
    expect(supportsPlatformFlags("9.7.0")).toBe(true);
    // A string compare would call this older than 9.7.0.
    expect(supportsPlatformFlags("9.10.0")).toBe(true);
    expect(supportsPlatformFlags("10.8.2")).toBe(true);
    expect(supportsPlatformFlags(" 10.8.2\n")).toBe(true);
  });

  it("assumes no support for anything it cannot parse", () => {
    expect(supportsPlatformFlags("")).toBe(false);
    expect(supportsPlatformFlags("garbage")).toBe(false);
  });
});

describe("packageSpec", () => {
  it("accepts ordinary and scoped names", () => {
    expect(packageSpec("arg", "4.1.5")).toBe("arg@4.1.5");
    expect(packageSpec("@babel/core", "7.24.0")).toBe("@babel/core@7.24.0");
    expect(packageSpec("node-fetch", "2.6.7-beta.1")).toBe("node-fetch@2.6.7-beta.1");
  });

  it("rejects a name that would escape the repo path", () => {
    expect(packageSpec("../../evil", "1.0.0")).toBeNull();
  });

  it("rejects shell metacharacters and uppercase", () => {
    expect(packageSpec("a; rm -rf /", "1.0.0")).toBeNull();
    expect(packageSpec("Arg", "1.0.0")).toBeNull();
  });

  it("rejects an over-long name", () => {
    expect(packageSpec("a".repeat(215), "1.0.0")).toBeNull();
  });

  it("rejects an empty name or a version that is not exact", () => {
    expect(packageSpec("", "1.0.0")).toBeNull();
    expect(packageSpec("arg", ">= 1.0.0")).toBeNull();
    expect(packageSpec("arg", "")).toBeNull();
  });
});

describe("npmIdentityFromUrl", () => {
  it("recovers the scope from the directory, which the filename drops", () => {
    expect(
      npmIdentityFromUrl("https://art.example.com/artifactory/npm-local/%40octokit/types/-/types-16.0.0.tgz")
    ).toEqual({ name: "@octokit/types", version: "16.0.0" });
  });

  it("handles an unscoped package and a version with dashes in it", () => {
    expect(npmIdentityFromUrl("https://registry.npmjs.org/arg/-/arg-4.1.5-beta.1.tgz")).toEqual({
      name: "arg",
      version: "4.1.5-beta.1",
    });
  });

  it("is null for anything not in the registry layout", () => {
    expect(npmIdentityFromUrl("https://github.com/acme/w/archive/v1.0.0.tar.gz")).toBeNull();
    // Right shape, wrong file: the basename has to match the package name, or
    // the split into name and version is a guess.
    expect(npmIdentityFromUrl("https://registry.npmjs.org/arg/-/other-4.1.5.tgz")).toBeNull();
  });
});
