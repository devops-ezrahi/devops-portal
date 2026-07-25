import { describe, expect, it } from "vitest";
import { parseZipName } from "./RealWhiteningApi";

describe("parseZipName", () => {
  it("splits team (first token), version (last token), and project (everything between)", () => {
    expect(parseZipName("acme-devops-portal-1.2.3.zip")).toEqual({
      team: "acme",
      project: "devops-portal",
      version: "1.2.3",
    });
  });

  it("handles a single-word project name", () => {
    expect(parseZipName("acme-widget-2.0.0.zip")).toEqual({
      team: "acme",
      project: "widget",
      version: "2.0.0",
    });
  });

  it("throws when the name has fewer than three segments", () => {
    expect(() => parseZipName("widget-2.0.0.zip")).toThrow(/must match/);
  });
});
