// State that outlives the component showing it (filters, open sections, chosen tabs), so leaving a screen and coming
// back finds it as it was — kept in memory for this page load only.
import { useCallback, useState } from 'react';

const memory = new Map();

export function useSticky(key, initial) {
  const [value, setValue] = useState(() => (memory.has(key) ? memory.get(key) : typeof initial === 'function' ? initial() : initial));
  const set = useCallback((next) => setValue((prev) => {
    const v = typeof next === 'function' ? next(prev) : next;
    memory.set(key, v);
    return v;
  }), [key]);
  return [value, set];
}

export const getSticky = (key, fallback) => (memory.has(key) ? memory.get(key) : fallback);
export const setSticky = (key, value) => memory.set(key, value);
