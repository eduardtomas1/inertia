import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

type PersistedSizeOptions = {
  min: number;
  max: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function storedSize(key: string, fallback: number, min: number, max: number): number {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return clamp(fallback, min, max);
    const value = Number(stored);
    return Number.isFinite(value) ? clamp(value, min, max) : clamp(fallback, min, max);
  } catch {
    return clamp(fallback, min, max);
  }
}

export function usePersistedSize(
  key: string,
  fallback: number,
  { min, max }: PersistedSizeOptions,
): [number, Dispatch<SetStateAction<number>>] {
  const [size, setSize] = useState(() => storedSize(key, fallback, min, max));

  const updateSize = useCallback<Dispatch<SetStateAction<number>>>((next) => {
    setSize((current) => clamp(typeof next === "function" ? next(current) : next, min, max));
  }, [max, min]);

  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(size));
    } catch {
      // Layout persistence is best effort and never blocks interaction.
    }
  }, [key, size]);

  return [size, updateSize];
}
