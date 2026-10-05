// Themes are not a second stylesheet. Every colour in styles.css is a palette
// variable named after its dark-theme hex (`--c-20c7bd: 32 199 189`), and a
// theme is a function over that palette: it reads each name, moves the colour
// in HSL, and writes the result back over :root. So a colour added to the CSS
// tomorrow is themed without anyone listing it here.

export type ThemeId = "dark" | "midnight" | "graphite" | "light";
export type AccentId = "teal" | "green" | "blue" | "indigo" | "violet" | "pink" | "orange";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "midnight", label: "Midnight" },
  { id: "graphite", label: "Graphite" },
  { id: "light", label: "Light" },
];

// The hue each accent turns the teal family to. Teal is the palette as written.
export const ACCENTS: { id: AccentId; label: string; hue: number }[] = [
  { id: "teal", label: "Teal", hue: 175 },
  { id: "green", label: "Green", hue: 140 },
  { id: "blue", label: "Blue", hue: 212 },
  { id: "indigo", label: "Indigo", hue: 236 },
  { id: "violet", label: "Violet", hue: 266 },
  { id: "pink", label: "Pink", hue: 326 },
  { id: "orange", label: "Orange", hue: 24 },
];

export type ThemeChoice = { theme: ThemeId; accent: AccentId };
export const DEFAULT_CHOICE: ThemeChoice = { theme: "dark", accent: "teal" };

// The colours the picker's previews are drawn from — the page background, a
// panel, body text and the accent, as the stylesheet names them.
export const ROLE = { page: "0b0f12", panel: "101a1e", border: "2a3940", text: "f4f7f8", accent: "20c7bd", onAccent: "041113" } as const;

const STORAGE_KEY = "portal.theme";
const TEAL = 175;

type Hsl = [number, number, number];

function hexToRgb(hex: string): [number, number, number] {
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function rgbToHsl([r, g, b]: [number, number, number]): Hsl {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

function hslToRgb([h, s, l]: Hsl): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255)) as [number, number, number];
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

// The teal family: the accent itself, its tints, and the near-black text that
// sits on an accent button. The slate neutrals share its hue range but are far
// less saturated, which is what tells the two apart (a selected row's tint,
// #132a2c, is the closest call: hue 185, saturation 0.40).
const isAccent = ([h, s]: Hsl) => h >= 160 && h <= 188 && s >= 0.38;
const isNeutral = ([h, s]: Hsl) => s < 0.25 || (h >= 183 && h <= 215 && s < 0.45);

/** One palette colour (its dark-theme hex) as the chosen theme paints it. */
export function themed(hex: string, { theme, accent }: ThemeChoice): [number, number, number] {
  let [h, s, l] = rgbToHsl(hexToRgb(hex));
  const accentLike = isAccent([h, s, l]);
  const neutral = !accentLike && isNeutral([h, s, l]);

  if (theme === "midnight" && neutral && s > 0.05) {
    h = 226;
    s = clamp(s * 1.3 + 0.06);
  }
  if (theme === "graphite" && neutral) s *= 0.12;
  if (theme === "light" && hex !== "000000") {
    if (accentLike && l < 0.1) {
      // Text on an accent button: the button stays mid-tone, so its text stays dark.
    } else if (s >= 0.4 && l >= 0.35 && l <= 0.68) {
      // A mid-tone colour (the accent, a status hue) is already a colour, not a
      // shade — inverting it would wash it out. Darken it enough to read on white.
      l *= 0.75;
    } else {
      l = 1 - l;
      if (neutral) l = Math.pow(l, 1.25);
    }
  }
  if (accentLike && accent !== "teal") {
    const target = ACCENTS.find((a) => a.id === accent)?.hue ?? TEAL;
    h = (h + target - TEAL + 360) % 360;
  }
  if (theme === "dark" && accent === "teal") return hexToRgb(hex);
  return hslToRgb([h, s, l]);
}

export function cssColor(hex: string, choice: ThemeChoice): string {
  return `rgb(${themed(hex, choice).join(" ")})`;
}

/** Every `--c-<hex>` the loaded stylesheets declare on :root. */
function paletteNames(): string[] {
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet (Google Fonts) cannot be read, and holds no palette
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ":root") continue;
      for (const prop of Array.from(rule.style)) if (/^--c-[0-9a-f]{6}$/.test(prop)) names.add(prop);
    }
  }
  return [...names];
}

export function loadChoice(): ThemeChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return {
      theme: THEMES.some((t) => t.id === raw?.theme) ? raw.theme : DEFAULT_CHOICE.theme,
      accent: ACCENTS.some((a) => a.id === raw?.accent) ? raw.accent : DEFAULT_CHOICE.accent,
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

export function saveChoice(choice: ThemeChoice) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // private window or blocked storage: the theme still applies for this visit
  }
}

/** Paints the choice over the stylesheet's own palette. Dark + teal is the
 *  stylesheet as written, so it removes the override rather than restating it. */
export function applyTheme(choice: ThemeChoice) {
  const id = "portal-theme";
  let el = document.getElementById(id) as HTMLStyleElement | null;
  document.documentElement.dataset.theme = choice.theme;
  if (choice.theme === "dark" && choice.accent === "teal") {
    el?.remove();
    return;
  }
  const vars = paletteNames().map((name) => `${name}: ${themed(name.slice(4), choice).join(" ")};`);
  if (choice.theme === "light") vars.push("--scheme: light;");
  if (!el) {
    el = document.createElement("style");
    el.id = id;
    document.head.appendChild(el);
  }
  // `:root:root` outranks the stylesheet's `:root` whatever order the two
  // <style> tags end up in — Vite injects CSS in dev after this may have run.
  el.textContent = `:root:root { ${vars.join(" ")} }`;
}
