import { useSyncExternalStore } from "react";
import {
  normalizeProjectHexColor,
  PROJECT_COLOR_PALETTE,
  type ProjectColor,
  type ProjectColorTints,
} from "@shared/project-colors";
import { createSurfaceLoader } from "../utils/surfaceLoader";

export const loadProjectColorContrast = createSurfaceLoader(() => import("@shared/project-color-contrast"));

const customTints = new Map<string, ProjectColorTints>();
const listeners = new Set<() => void>();
let revision = 0;
let contrastLoad: Promise<void> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publishLoaded(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function useProjectColorRevision(): number {
  return useSyncExternalStore(subscribe, () => revision, () => revision);
}

export function projectColorTints(color: ProjectColor | null | undefined): ProjectColorTints | null {
  if (!color) return null;
  if (color.kind === "palette") return PROJECT_COLOR_PALETTE[color.name] ?? null;
  const value = normalizeProjectHexColor(color.value);
  if (!value) return null;
  const cached = customTints.get(value);
  if (cached) return cached;
  const contrast = loadProjectColorContrast.peek();
  if (!contrast) {
    // One load at a time; a rejected chunk load is retried by the next request
    // instead of leaving custom colours untinted for the rest of the session.
    contrastLoad ??= loadProjectColorContrast().then(publishLoaded, () => undefined)
      .finally(() => { contrastLoad = null; });
    return null;
  }
  const tints = { light: contrast.adaptProjectColor(value, "light"), dark: contrast.adaptProjectColor(value, "dark") };
  if (customTints.size >= 64) customTints.clear();
  customTints.set(value, tints);
  return tints;
}
