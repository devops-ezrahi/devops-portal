import { describe, expect, it } from "vitest";
import { classifyLogLine } from "./logLines";

describe("classifyLogLine", () => {
  it("pulls the package out of an upload success", () => {
    expect(classifyLogLine("Uploaded left-pad@1.3.0")).toEqual({
      className: "log-uploaded",
      pkg: "left-pad@1.3.0",
      text: "",
      badge: "Uploaded",
    });
  });

  it("splits a failure into package and reason", () => {
    expect(classifyLogLine("Failed @babel/core@7.24.0: Artifactory responded 403 Forbidden")).toEqual({
      className: "log-failed",
      pkg: "@babel/core@7.24.0",
      text: "Artifactory responded 403 Forbidden",
      badge: "Failed",
    });
  });

  it("marks both wordings of an already-present artifact as skipped", () => {
    expect(classifyLogLine("1 package(s) already in the repo — skipping.").className).toBe("log-skipped");
    expect(classifyLogLine("npm-local/arg/-/arg-4.1.5.tgz already exists — skipping.").className).toBe("log-skipped");
  });

  it("leaves ordinary lines unstyled so CLI output stays plain", () => {
    expect(classifyLogLine("$ git clone --depth 1 https://host/repo.git repo").className).toBe("");
    expect(classifyLogLine("Checking 3 package(s) against npm-local ...").className).toBe("");
  });

  it("treats the closing tally as a summary, not a package line", () => {
    expect(classifyLogLine("Done. 1 uploaded, 1 already present, 1 failed.")).toEqual({
      className: "log-summary",
      text: "Done. 1 uploaded, 1 already present, 1 failed.",
    });
  });
});
