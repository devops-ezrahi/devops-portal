// Themes are not a second stylesheet. Every colour in styles.css is a palette
// variable named after its dark-theme hex (`--c-20c7bd: 32 199 189`), and a
// theme is a function over that palette: it reads each name, moves the colour
// in HSL, and writes the result back over :root. So a colour added to the CSS
// tomorrow is themed without anyone listing it here.

export type ThemeId = "dark" | "light";
export type AccentId = "teal" | "green" | "blue" | "violet" | "pink" | "orange" | "red" | "custom";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

// The hue each accent turns the teal family to. Teal is the palette as written.
// "custom" is not listed: it is the colour the user picked.
// `light` is the accent itself on the light theme, chosen by hand: the
// dark-theme accent darkened and hue-turned came out muddy (orange went brown).
export const ACCENTS: { id: Exclude<AccentId, "custom">; label: string; hue: number; light: string }[] = [
  { id: "teal", label: "Teal", hue: 175, light: "0d9488" },
  { id: "green", label: "Green", hue: 140, light: "16a34a" },
  { id: "blue", label: "Blue", hue: 212, light: "2563eb" },
  { id: "violet", label: "Violet", hue: 266, light: "7c3aed" },
  { id: "pink", label: "Pink", hue: 326, light: "db2777" },
  { id: "orange", label: "Orange", hue: 24, light: "ea580c" },
  { id: "red", label: "Red", hue: 0, light: "dc2626" },
];

// `custom` is the picked colour as a 6-digit hex, kept even while a preset is
// chosen so the picker reopens on it.
export type ThemeChoice = { theme: ThemeId; accent: AccentId; custom?: string };
export const DEFAULT_CHOICE: ThemeChoice = { theme: "dark", accent: "teal", custom: "e05560" };

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

/** A colour as the theme alone paints it — the accent still teal. */
function shade(hex: string, theme: ThemeId): Hsl {
  let [h, s, l] = rgbToHsl(hexToRgb(hex));
  if (theme === "light" && hex !== "000000") {
    if (s >= 0.4 && l >= 0.35 && l <= 0.68) {
      // A mid-tone colour (the accent, a status hue) is already a colour, not a
      // shade — inverting it would wash it out. Darken it enough to read on
      // white, and saturate the accent back up, since darkening greys it.
      l *= 0.75;
      if (isAccent([h, s, l])) s = clamp(s * 1.15);
    } else {
      const neutral = isNeutral([h, s, l]) && !isAccent([h, s, l]);
      l = 1 - l;
      if (neutral) l = Math.pow(l, 1.25);
    }
  }
  return [h, s, l];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isHex = (v?: string): v is string => /^[0-9a-f]{6}$/.test(v ?? "");

/** One palette colour (its dark-theme hex) as the chosen theme paints it. */
export function themed(hex: string, choice: ThemeChoice): [number, number, number] {
  const { theme, accent, custom } = choice;
  if (theme === "dark" && accent === "teal") return hexToRgb(hex);

  const src = rgbToHsl(hexToRgb(hex));
  if (!isAccent(src)) return hslToRgb(shade(hex, theme));

  if (src[2] < 0.1) {
    // Text on an accent button: whichever of near-black or white reads on the
    // button as painted. Biased to white (0.4, not the 0.18 crossover), which
    // keeps dark text on bright teal but puts white on every deep accent.
    const bg = themed(ROLE.accent, choice);
    return luminance(bg) > 0.4 ? hslToRgb([rgbToHsl(bg)[0], 0.6, 0.06]) : [252, 252, 252];
  }

  let [h, s, l] = shade(hex, theme);
  const preset = ACCENTS.find((a) => a.id === accent);
  const exact = accent === "custom" ? (isHex(custom) ? custom : null) : theme === "light" ? preset?.light : null;
  if (exact) {
    // This colour *is* the accent; every tint and hover shade keeps its
    // distance from it. Shades near the accent move with its lightness, the
    // far tints (selected-row backgrounds) hardly at all.
    const [ph, ps, pl] = rgbToHsl(hexToRgb(exact));
    const [, bs, bl] = shade(ROLE.accent, theme);
    const near = Math.max(0, 1 - Math.abs(l - bl) / 0.35);
    return hslToRgb([ph, clamp(s * (ps / bs)), clamp(l + (pl - bl) * near)]);
  }
  const target = preset?.hue ?? TEAL;
  return hslToRgb([(h + target - TEAL + 360) % 360, s, l]);
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
      accent: raw?.accent === "custom" || ACCENTS.some((a) => a.id === raw?.accent) ? raw.accent : DEFAULT_CHOICE.accent,
      custom: isHex(raw?.custom) ? raw.custom : DEFAULT_CHOICE.custom,
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
