import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pop } from "./Pop";

// jsdom has no Web Animations API; the stub is what records a pop.
const animate = vi.fn();
beforeEach(() => {
  animate.mockClear();
  Element.prototype.animate = animate as unknown as Element["animate"];
});
afterEach(() => {
  delete (Element.prototype as Partial<Element>).animate;
});

describe("Pop", () => {
  it("pops on a change of value only — never on mount, never on an equal re-render", () => {
    const { rerender } = render(<Pop value="Submitted">Submitted</Pop>);
    expect(animate).not.toHaveBeenCalled();

    rerender(<Pop value="Submitted">Submitted</Pop>);
    expect(animate).not.toHaveBeenCalled();

    rerender(<Pop value="In Review">In Review</Pop>);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("pops on mount when asked to appear", () => {
    render(<Pop value appear>override</Pop>);
    expect(animate).toHaveBeenCalledTimes(1);
  });
});
