import { describe, expect, it } from "vitest";
import { themed } from "./theme";

const lum = ([r, g, b]: number[]) => (r + g + b) / 3;

describe("themed", () => {
  it("leaves the stylesheet's own palette alone for dark + teal", () => {
    expect(themed("20c7bd", { theme: "dark", accent: "teal" })).toEqual([32, 199, 189]);
    expect(themed("0b0f12", { theme: "dark", accent: "teal" })).toEqual([11, 15, 18]);
  });

  it("turns the page light and the text dark in the light theme", () => {
    const c = { theme: "light", accent: "teal" } as const;
    expect(lum(themed("0b0f12", c))).toBeGreaterThan(220);
    expect(lum(themed("f4f7f8", c))).toBeLessThan(30);
    // text on an accent button turns white, since the button is darkened
    expect(lum(themed("041113", c))).toBeGreaterThan(240);
    expect(lum(themed("20c7bd", c))).toBeLessThan(140);
    // shadows and backdrops stay shadows
    expect(themed("000000", c)).toEqual([0, 0, 0]);
  });

  it("moves the accent family and nothing else", () => {
    const c = { theme: "dark", accent: "blue" } as const;
    const [r, , b] = themed("20c7bd", c);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(themed("20c7bd", c)[1]);
    expect(themed("e05560", c)).toEqual(themed("e05560", { theme: "dark", accent: "teal" })); // error red stays red
  });

  it("takes a custom accent's hue from the picked colour", () => {
    const [r, g, b] = themed("20c7bd", { theme: "dark", accent: "custom", custom: "ff0000" });
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it("paints a custom accent as exactly the picked colour, in either theme", () => {
    for (const theme of ["dark", "light"] as const) {
      const c = { theme, accent: "custom", custom: "ffb000" } as const;
      expect(themed("20c7bd", c)).toEqual([255, 176, 0]);
    }
    // text on it follows the button: dark on bright amber, white on deep navy
    expect(lum(themed("041113", { theme: "dark", accent: "custom", custom: "ffb000" }))).toBeLessThan(30);
    expect(lum(themed("041113", { theme: "dark", accent: "custom", custom: "1a2a6c" }))).toBeGreaterThan(240);
  });
});
