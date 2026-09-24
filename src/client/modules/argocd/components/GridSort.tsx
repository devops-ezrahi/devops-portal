import { useState } from "react";

export type Sorts<T> = Record<string, { label: string; by: (a: T, b: T) => number }>;

/**
 * A grid's display order. Display only — the tree keeps the order things were
 * added in, which is also the order the files are written. Remembered per
 * browser, since it is a way of looking, not part of the document.
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
  // Array.sort is stable, so ties keep the order they were added in.
  const order = <U extends T>(items: U[]) => [...items].sort(sorts[sort].by);
  const control = (
    <label className="ag-grid-sort">
      Sort
      <select value={sort} onChange={(e) => choose(e.target.value)}>
        {Object.entries(sorts).map(([key, s]) => (
          <option key={key} value={key}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
  return { order, control };
}
