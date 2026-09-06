import { describe, expect, it } from "vitest";
import { flow, raw, toYaml } from "./yaml";

describe("toYaml", () => {
  it("quotes what YAML would otherwise re-type", () => {
    expect(toYaml({ tag: "2.3", on: "yes", n: "1", ok: "v1.2.3" })).toBe('tag: "2.3"\non: "yes"\nn: "1"\nok: v1.2.3');
  });

  it("drops unset fields rather than writing them empty", () => {
    expect(toYaml({ a: "x", b: "", c: null, d: {}, e: [] })).toBe("a: x");
  });

  it("writes nested maps and lists of maps", () => {
    expect(toYaml({ hosts: [{ host: "a.example.com", paths: [{ path: "/" }] }] })).toBe(
      "hosts:\n  - host: a.example.com\n    paths:\n      - path: /"
    );
  });

  it("writes a multi-line string as a block scalar, keeping a trailing newline", () => {
    expect(toYaml({ file: "a\nb\n" })).toBe("file: |\n  a\n  b");
    expect(toYaml({ file: "a\nb" })).toBe("file: |-\n  a\n  b");
  });

  it("passes a raw block and a flow sequence through", () => {
    expect(toYaml({ strategy: raw("type: Recreate"), ports: flow([80, 443]) })).toBe(
      "strategy:\n  type: Recreate\nports: [80, 443]"
    );
  });
});
