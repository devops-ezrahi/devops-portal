import { Pop } from "../../../Pop";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";

export type Sorts<T> = Record<string, { label: string; by: (a: T, b: T) => number }>;

/**
 * A grid's display order. Display only — "Your order" is the tree's own order,
 * which is also the order the files are written and what dragging a card
 * changes. Remembered per browser, since it is a way of looking, not part of
 * the document.
 */
export function useGridSort<T>(sorts: Sorts<T>, storageKey: string) {
  const [sort, setSort] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved && saved in sorts ? saved : "added";
    } catch {
      return "added";
    }
  });
  const choose = (next: string) => {
    setSort(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* private window — the choice just is not remembered */
    }
  };
  // Array.sort is stable, so ties keep the tree's own order.
  const order = <U extends T>(items: U[]) => [...items].sort(sorts[sort].by);
  const control = (hidden: boolean) => (
    // Kept in the heading row and hidden rather than removed below two cards, so
    // adding the second one does not push the grid down.
    <SortMenu sorts={sorts} value={sort} onChange={choose} hidden={hidden} />
  );
  // A drag is a statement about the order you want, so the grid then shows it.
  return { order, control, manual: () => choose("added") };
}

/**
 * The sort list, drawn as the header's theme menu rather than a native
 * `<select>`: the popup a select opens is the platform's, and no stylesheet
 * reaches its highlight or frame, so it never matched the rest of the page.
 */
function SortMenu<T>({ sorts, value, onChange, hidden }: { sorts: Sorts<T>; value: string; onChange: (key: string) => void; hidden: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="ag-grid-sort" ref={root} style={hidden ? { visibility: "hidden" } : undefined}>
      Sort
      <button type="button" className="ag-sort-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Pop value={value}>{sorts[value].label}</Pop>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="theme-menu ag-sort-menu" role="menu">
          {Object.entries(sorts).map(([key, s]) => (
            <button
              key={key}
              type="button"
              role="menuitemradio"
              aria-checked={key === value}
              className={`theme-row${key === value ? " selected" : ""}`}
              onClick={() => {
                onChange(key);
                setOpen(false);
              }}
            >
              <span className="theme-row-label">{s.label}</span>
              {key === value && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Drag a card onto another to move it there — native HTML5, like the
 * Jenkinsfile builder's stage list. `order` is the keys as displayed; `onReorder`
 * gets them back with the dragged one moved.
 */
export function useGridDrag<K>(order: K[], onReorder: (next: K[]) => void) {
  const [dragging, setDragging] = useState<K | null>(null);
  const [over, setOver] = useState<K | null>(null);
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  return (key: K, enabled = true) => ({
    draggable: enabled,
    "data-drag": dragging === key ? "source" : dragging !== null && over === key ? "target" : undefined,
    onDragStart: (e: DragEvent) => {
      setDragging(key);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");
    },
    onDragOver: (e: DragEvent) => {
      if (dragging === null) return;
      e.preventDefault();
      if (over !== key) setOver(key);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragging !== null && dragging !== key) {
        const forward = order.indexOf(dragging) < order.indexOf(key);
        const next = order.filter((k) => k !== dragging);
        next.splice(next.indexOf(key) + (forward ? 1 : 0), 0, dragging);
        onReorder(next);
      }
      end();
    },
    onDragEnd: end,
  });
}
