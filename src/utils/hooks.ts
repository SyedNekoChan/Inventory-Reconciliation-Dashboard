import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Debounced mirror of a rapidly changing value (search inputs). */
export function useDebounced<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** localStorage-backed state. Safe when storage is blocked. */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setState((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* storage unavailable — keep in-memory value */
        }
        return resolved;
      });
    },
    [key],
  );

  return [state, set];
}

/** Stable pagination state helper. */
export function usePagination(pageSize: number, total: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);
  return useMemo(
    () => ({
      page,
      pageCount,
      setPage,
      offset: page * pageSize,
      next: () => setPage((p) => Math.min(p + 1, pageCount - 1)),
      prev: () => setPage((p) => Math.max(p - 1, 0)),
      reset: () => setPage(0),
    }),
    [page, pageCount, pageSize],
  );
}

/** Element size observer, for virtualized table viewports. */
export function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setHeight(entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}
