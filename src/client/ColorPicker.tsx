import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { isHex } from "./theme";

// The theme menu's custom-accent editor: a saturation/brightness square, a
// hue strip and a hex field. Built rather than <input type="color"> because
// the native one is a different dialog on every OS, none of which look like
// this app. HSV is held in state, not derived from the hex, so dragging to
// grey or black does not throw the hue away.

type Hsv = [number, number, number]; // h 0-360, s 0-1, v 0-1

function hexToHsv(hex: string): Hsv {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, max ? d / max : 0, max];
}

function hsvToHex([h, s, v]: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("");
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

// Pointer drag on an element: reports the position as 0-1 fractions.
function useDrag(onMove: (x: number, y: number) => void) {
  const move = (e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onMove(clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height));
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      move(e);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
    },
  };
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const last = useRef(value);

  // Only an outside change (not our own echo) re-seeds the HSV.
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    setHsv(hexToHsv(value));
    setText(value);
  }, [value]);

  const set = (next: Hsv) => {
    const hex = hsvToHex(next);
    setHsv(next);
    setText(hex);
    last.current = hex;
    onChange(hex);
  };

  const [h, s, v] = hsv;
  const area = useDrag((x, y) => set([h, x, 1 - y]));
  const strip = useDrag((x) => set([Math.min(359.9, x * 360), s, v]));

  const areaKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    set([h, clamp(s + d[0]), clamp(v + d[1])]);
  };
  const stripKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 3;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    set([(h + d + 360) % 360, s, v]);
  };

  return (
    <div className="color-picker">
      <div
        className="color-area"
        style={{ backgroundColor: `hsl(${h} 100% 50%)` }}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`}
        onKeyDown={areaKeys}
        {...area}
      >
        <span className="color-thumb" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: `#${hsvToHex(hsv)}` }} />
      </div>
      <div
        className="color-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(h)}
        onKeyDown={stripKeys}
        {...strip}
      >
        <span className="color-thumb" style={{ left: `${(h / 360) * 100}%`, background: `hsl(${h} 100% 50%)` }} />
      </div>
      <div className="color-hex-row">
        <span className="color-swatch" style={{ background: `#${hsvToHex(hsv)}` }} aria-hidden="true" />
        <label className="color-hex">
          <span aria-hidden="true">#</span>
          <input
            aria-label="Hex colour"
            value={text}
            maxLength={7}
            spellCheck={false}
            onChange={(e) => {
              const t = e.target.value.replace(/^#/, "").toLowerCase();
              setText(t);
              if (isHex(t)) set(hexToHsv(t));
            }}
            onBlur={() => setText(hsvToHex(hsv))}
          />
        </label>
      </div>
    </div>
  );
}
