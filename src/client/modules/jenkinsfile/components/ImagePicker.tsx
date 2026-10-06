import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PickableImage } from "../api";

/**
 * The `image` argument's field: a text input that also drops a list of the
 * images Artifactory knows about, each with its labels beside it.
 *
 * It is a combobox rather than a `<select>` because an image that is not on the
 * list must still be typeable — the list is a convenience, not a constraint,
 * and a picker that could not reach Artifactory would otherwise take the field
 * with it. It replaced a native `<datalist>`, which cannot lay a row out in two
 * columns and always opens downwards.
 */
export function ImagePicker({
  id,
  value,
  placeholder,
  images,
  onChange,
}: {
  id: string;
  value: string;
  placeholder?: string;
  images: PickableImage[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Typing filters; opening the list by hand does not, or picking an image
  // would leave the list showing only the image just picked.
  const [typed, setTyped] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const query = value.trim().toLowerCase();
  const shown = typed && query ? images.filter((i) => i.name.toLowerCase().includes(query)) : images;

  // Same as the stage palette: a popover that only closed on its own control
  // would sit over whatever gets clicked next.
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Open upwards when the field is near the bottom of the window — a stage card
  // low in a long list is exactly where this field usually is.
  useLayoutEffect(() => {
    if (!open || !box.current) return;
    const { top, bottom } = box.current.getBoundingClientRect();
    const below = window.innerHeight - bottom;
    setUp(below < Math.min(280, shown.length * 34 + 16) && top > below);
  }, [open, shown.length]);

  useEffect(() => {
    // Optional call: not every environment implements it (jsdom does not), and
    // keeping the active row in view is not worth throwing over.
    (list.current?.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function choose(name: string) {
    onChange(name);
    setOpen(false);
    setTyped(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (shown.length ? (a + step + shown.length) % shown.length : 0));
    } else if (e.key === "Enter" && open && shown[active]) {
      // Only swallow Enter when it is actually picking something off the list.
      e.preventDefault();
      choose(shown[active].name);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="jf-imagepicker" ref={box}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setTyped(true);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        // Pressing the field itself opens the list — the chevron is a target to
        // aim at, not the only way in. Not onFocus: tabbing through the form
        // would then drop a list over the next argument on the way past.
        onClick={() => {
          if (!open) {
            setTyped(false);
            setActive(0);
            setOpen(true);
          }
        }}
      />
      <button
        type="button"
        className="jf-imagepicker-toggle"
        // The input keeps the label, so this needs its own name.
        aria-label={open ? "Hide images" : "Show images"}
        tabIndex={-1}
        onClick={() => {
          setTyped(false);
          setActive(0);
          setOpen((o) => !o);
        }}
      >
        <ChevronDown size={15} aria-hidden="true" className={open ? "jf-imagepicker-flip" : undefined} />
      </button>

      {open && shown.length > 0 && (
        <ul className={`jf-imagepicker-list${up ? " jf-imagepicker-up" : ""}`} id={`${id}-list`} role="listbox" ref={list}>
          {shown.map((image, i) => (
            <li
              key={image.name}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={image.name === value}
              className={i === active ? "jf-imagepicker-active" : undefined}
              // pointerdown, not click: the input's blur would otherwise close
              // the list out from under the press that is choosing from it.
              onPointerDown={(e) => {
                e.preventDefault();
                choose(image.name);
              }}
              onPointerEnter={() => setActive(i)}
            >
              <span className="jf-imagepicker-name">{image.name}</span>
              {image.info && <span className="jf-imagepicker-info">{image.info}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
