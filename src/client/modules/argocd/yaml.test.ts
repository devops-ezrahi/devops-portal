import { describe, expect, it } from "vitest";
import { flow, raw, toYaml } from "./yaml";
import { parse } from "yaml";

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

describe("block scalars read back exactly", () => {
  // ConfigMap files: an XML fragment whose first line is indented lost that
  // indentation (YAML takes it from the first line unless told), and a file
  // ending in blank lines was cut to one newline.
  const cases: Record<string, string> = {
    "an indented first line": '  <Root level="INFO"/>\n</Configuration>\n',
    "nested XML": '<Configuration status="INFO">\n  <Appenders>\n    <Console name="console"/>\n  </Appenders>\n</Configuration>\n',
    "no trailing newline": "# DB\ndbServer=db\n\ndbPort=5000",
    "several trailing newlines": "a\n\n\n",
    "a leading blank line": "\nfirst after blank\n",
    "trailing spaces": "a  \nb\n",
  };
  for (const [name, text] of Object.entries(cases))
    it(name, () => {
      const out = `${toYaml({ configMaps: { c: { data: { f: text } } } })}\n`;
      expect((parse(out) as { configMaps: { c: { data: { f: string } } } }).configMaps.c.data.f, out).toBe(text);
    });
});
