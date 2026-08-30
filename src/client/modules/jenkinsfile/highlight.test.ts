import { describe, expect, it } from "vitest";
import { highlightGroovy } from "./highlight";

describe("highlightGroovy", () => {
  it("colours the step name, its arguments and its strings", () => {
    const html = highlightGroovy("genStage(\n    title: 'Build',\n)");
    expect(html).toContain('<span class="hljs-title function_">genStage</span>');
    expect(html).toMatch(/hljs-(attr|symbol)">title:/);
    expect(html).toContain("hljs-string");
  });

  it("leaves control flow as a keyword", () => {
    expect(highlightGroovy("if (x) { }")).toContain('<span class="hljs-keyword">if</span>');
  });
});
