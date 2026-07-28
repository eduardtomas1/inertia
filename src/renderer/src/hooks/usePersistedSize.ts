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
  const [persisted, setPersisted] = useState(() => ({
    key,
    size: storedSize(key, fallback, min, max),
  }));
  const size = persisted.key === key
    ? persisted.size
    : storedSize(key, fallback, min, max);

  const updateSize = useCallback<Dispatch<SetStateAction<number>>>((next) => {
    setPersisted((current) => {
      const currentSize = current.key === key
        ? current.size
        : storedSize(key, fallback, min, max);
      return {
        key,
        size: clamp(
          typeof next === "function" ? next(currentSize) : next,
          min,
          max,
        ),
      };
    });
  }, [fallback, key, max, min]);

  useEffect(() => {
    if (persisted.key !== key) {
      setPersisted({
        key,
        size: storedSize(key, fallback, min, max),
      });
      return;
    }
    try {
      window.localStorage.setItem(key, String(persisted.size));
    } catch {
      // Layout persistence is best effort and never blocks interaction.
    }
  }, [fallback, key, max, min, persisted]);

  return [size, updateSize];
}
