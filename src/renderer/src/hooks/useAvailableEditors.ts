import { createContext, useContext, useEffect, useState } from "react";

import {
  DEFAULT_PREFERRED_EDITOR,
  type DetectedEditor,
  type PreferredEditor,
} from "@shared/editor-ids";

interface AvailableEditorsState {
  editors: readonly DetectedEditor[];
  loaded: boolean;
}

let cachedEditors: readonly DetectedEditor[] = [];
let hasLoadedEditors = false;
let pendingRequest: Promise<readonly DetectedEditor[]> | null = null;
const subscribers = new Set<(state: AvailableEditorsState) => void>();

function notify(state: AvailableEditorsState): void {
  for (const subscriber of subscribers) subscriber(state);
}

export function resetAvailableEditorsCacheForTests(): void {
  cachedEditors = [];
  hasLoadedEditors = false;
  pendingRequest = null;
}

export async function loadAvailableEditors(refresh = false): Promise<readonly DetectedEditor[]> {
  const fetcher = window.inertia?.getAvailableEditors;
  if (!fetcher) return [];
  if (!refresh && hasLoadedEditors) return cachedEditors;
  if (!refresh && pendingRequest) return await pendingRequest;
  const request = fetcher(refresh ? { refresh: true } : undefined)
    .then((editors) => {
      cachedEditors = Array.isArray(editors) ? editors : [];
      hasLoadedEditors = true;
      notify({ editors: cachedEditors, loaded: true });
      return cachedEditors;
    })
    .catch(() => {
      hasLoadedEditors = true;
      notify({ editors: cachedEditors, loaded: true });
      return cachedEditors;
    })
    .finally(() => {
      if (pendingRequest === request) pendingRequest = null;
    });
  pendingRequest = request;
  return await request;
}

export function useAvailableEditors(options: { refresh?: boolean } = {}): AvailableEditorsState {
  const refresh = options.refresh === true;
  const [state, setState] = useState<AvailableEditorsState>(() => ({
    editors: cachedEditors,
    loaded: hasLoadedEditors,
  }));

  useEffect(() => {
    subscribers.add(setState);
    void loadAvailableEditors(refresh);
    return () => {
      subscribers.delete(setState);
    };
  }, [refresh]);

  return state;
}

export interface EditorPreferenceContextValue {
  preferredEditor: PreferredEditor;
  detectedEditors: readonly DetectedEditor[];
}

export const EditorPreferenceContext = createContext<EditorPreferenceContextValue>({
  preferredEditor: DEFAULT_PREFERRED_EDITOR,
  detectedEditors: [],
});

export function useEditorPreference(): EditorPreferenceContextValue {
  return useContext(EditorPreferenceContext);
}
