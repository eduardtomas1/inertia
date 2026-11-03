import type { LibraryCategory } from "@shared/library";

const LAST_CATEGORY_KEY = "inertia:library:last-category:v1";
const UNSORTED_VALUE = "unsorted";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastLibraryCategory(categories: readonly LibraryCategory[]): string | null {
  let stored: string | null = null;
  try {
    stored = storage()?.getItem(LAST_CATEGORY_KEY) ?? null;
  } catch {
    return null;
  }
  if (!stored || stored === UNSORTED_VALUE) return null;
  return categories.some(({ id }) => id === stored) ? stored : null;
}

export function rememberLibraryCategory(categoryId: string | null): void {
  try {
    storage()?.setItem(LAST_CATEGORY_KEY, categoryId ?? UNSORTED_VALUE);
  } catch {
    return;
  }
}

export function libraryError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
