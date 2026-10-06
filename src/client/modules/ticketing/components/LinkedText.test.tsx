import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkedText } from "./LinkedText";

function links(text: string) {
  const { container } = render(<p><LinkedText text={text} /></p>);
  return {
    text: container.textContent,
    anchors: [...container.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]),
  };
}

describe("LinkedText", () => {
  it("links a bare URL and keeps the sentence's punctuation outside it", () => {
    const r = links("See https://jira.example.com/browse/OPS-1. Thanks");
    expect(r.anchors).toEqual([["https://jira.example.com/browse/OPS-1", "https://jira.example.com/browse/OPS-1"]]);
    expect(r.text).toBe("See https://jira.example.com/browse/OPS-1. Thanks");
  });

  it("drops an unbalanced closing bracket but keeps a balanced one", () => {
    expect(links("(see http://a.io/x)").anchors[0][1]).toBe("http://a.io/x");
    expect(links("http://en.wikipedia.org/wiki/Foo_(bar)").anchors[0][1]).toBe("http://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("reads Jira's [text|url] and [url] markup", () => {
    const r = links("Logs: [build 42|https://ci.example.com/42] and [https://x.io/y]");
    expect(r.anchors).toEqual([
      ["build 42", "https://ci.example.com/42"],
      ["https://x.io/y", "https://x.io/y"],
    ]);
    expect(r.text).toBe("Logs: build 42 and https://x.io/y");
  });

  it("opens in a new tab and never links a non-http scheme", () => {
    render(<p><LinkedText text="ok https://a.io bad javascript:alert(1) [x|javascript:alert(1)]" /></p>);
    const a = screen.getAllByRole("link");
    expect(a).toHaveLength(1);
    expect(a[0].getAttribute("target")).toBe("_blank");
    expect(a[0].getAttribute("rel")).toBe("noreferrer");
  });

  it("leaves text with no link untouched, line breaks included", () => {
    expect(links("one\ntwo").text).toBe("one\ntwo");
  });
});
