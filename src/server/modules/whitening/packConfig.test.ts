import { describe, expect, it } from "vitest";
import { parsePackConfig, parsePreserve } from "./RealWhiteningApi";

const valid = {
  version: "1.0.1",
  repos: {
    "devops-portal": { department: "ultra", team: "optimus", repository: "inner-portal" },
  },
};

describe("parsePackConfig", () => {
  it("reads the packer's repository/config.json", () => {
    expect(parsePackConfig(JSON.stringify(valid))).toEqual({
      project: "devops-portal",
      version: "1.0.1",
      department: "ultra",
      team: "optimus",
      repository: "inner-portal",
    });
  });

  it("rejects a config with no repos entry", () => {
    expect(() => parsePackConfig(JSON.stringify({ version: "1.0.1", repos: {} }))).toThrow(/under repos/);
  });

  it("rejects a repos entry missing required fields", () => {
    expect(() =>
      parsePackConfig(JSON.stringify({ version: "1.0.1", repos: { widget: { team: "optimus" } } }))
    ).toThrow(/version, department, team and repository/);
  });

  it("rejects malformed JSON", () => {
    expect(() => parsePackConfig("not json")).toThrow(/not valid JSON/);
  });
});

describe("parsePreserve", () => {
  it("reads the target repo's preserve list", () => {
    expect(parsePreserve(JSON.stringify({ images: false, preserve: [".github/**", "local.env"] }))).toEqual([
      ".github/**",
      "local.env",
    ]);
  });

  it("treats a file with no preserve key as protecting nothing", () => {
    expect(parsePreserve(JSON.stringify({ images: false }))).toEqual([]);
    expect(parsePreserve(JSON.stringify({ preserve: "docs" }))).toEqual([]);
  });

  it("drops entries that are not usable patterns", () => {
    expect(parsePreserve(JSON.stringify({ preserve: ["keep.txt", "", "  ", 7, null] }))).toEqual(["keep.txt"]);
  });

  it("rejects malformed JSON rather than silently protecting nothing", () => {
    expect(() => parsePreserve("not json")).toThrow(/not valid JSON/);
  });
});
