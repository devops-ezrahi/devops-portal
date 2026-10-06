import { describe, expect, it } from "vitest";
import { highlightFile } from "./highlight";

describe("highlightFile", () => {
  it("colours by the file key's extension", () => {
    expect(highlightFile("log4j2.xml", '<Root level="INFO"/>')).toContain("hljs-tag");
    expect(highlightFile("Stalker.properties", "dbPort=5000")).toContain("hljs-attr");
  });

  it("escapes whatever it cannot place", () => {
    expect(highlightFile("", "<b>&")).not.toContain("<b>");
  });
});
