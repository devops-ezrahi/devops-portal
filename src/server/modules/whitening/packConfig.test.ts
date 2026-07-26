import { describe, expect, it } from "vitest";
import { parsePackConfig } from "./RealWhiteningApi";

describe("parsePackConfig", () => {
  it("reads the packer's config.json", () => {
    expect(
      parsePackConfig(
        JSON.stringify({
          project: "devops-portal",
          version: "1.2.3",
          team: "dvps",
          repo: "inner-portal",
          exclude: [".github/**"],
        })
      )
    ).toEqual({
      project: "devops-portal",
      version: "1.2.3",
      team: "dvps",
      repo: "inner-portal",
      exclude: [".github/**"],
    });
  });

  it("defaults repo to the project name and exclude to empty", () => {
    const config = parsePackConfig(JSON.stringify({ project: "widget", version: "2.0.0", team: "dvps" }));
    expect(config.repo).toBe("widget");
    expect(config.exclude).toEqual([]);
  });

  it("rejects a config missing required fields", () => {
    expect(() => parsePackConfig(JSON.stringify({ project: "widget" }))).toThrow(/project, version and team/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parsePackConfig("not json")).toThrow(/not valid JSON/);
  });
});
