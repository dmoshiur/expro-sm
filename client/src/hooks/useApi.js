/** Data-fetching + debounce hooks (no state library). */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useApi(fn, deps, { immediate }) -> { data, error, loading, reload, setData }
 * Cancels stale responses so fast filter changes never flash old data.
 */
export function useApi(fn, deps = [], { immediate = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const requestId = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current();
      if (requestId.current === id) setData(result);
      return result;
    } catch (err) {
      if (requestId.current === id) setError(err);
      return null;
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (immediate) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload: run, setData };
}

export function useDebounce(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Small async action helper with busy state and error surfaced to the caller. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run, setError };
}

/** Local storage backed state (used for filters that should stick). */
export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota/privacy errors */
    }
  }, [key, value]);
  return [value, setValue];
}
