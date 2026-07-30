import { describe, expect, it } from "vitest";
import { parsePackConfig } from "./RealWhiteningApi";

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
