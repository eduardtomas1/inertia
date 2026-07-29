import type {
  AccessMode,
  AppSettings,
  AppSnapshot,
  InteractionMode,
  ModelSelection,
  Project,
} from "@shared/contracts";
import {
  legacyProviderIdForHarness,
  nativeModelSelection,
} from "../../../shared/model-routing";
import {
  buildNewConversationPayload,
  withNewConversationModelSelection,
  type NewConversationPayload,
} from "../lib/newConversation";
import type { ComposerModelRoute } from "./modelChooserRoutes";

export const MULTI_SPAWN_PRESET_STORAGE_KEY =
  "inertia:multi-spawn:preset:v1";

const ACCESS_MODES = new Set<AccessMode>([
  "supervised",
  "auto-edit",
  "full",
]);
const MAX_TITLE_LENGTH = 120;
const MAX_ROUTE_ID_LENGTH = 512;
const MAX_REASONING_LENGTH = 64;

export interface MultiSpawnRouteReference {
  harnessId: string;
  backendProfileId: string;
  modelId: string;
  reasoningEffort: string | null;
}

export interface MultiSpawnPresetSide {
  title: string;
  route: MultiSpawnRouteReference;
  accessMode: AccessMode;
}

export interface MultiSpawnPreset {
  version: 1;
  sides: [MultiSpawnPresetSide, MultiSpawnPresetSide];
}

export interface MultiSpawnSideDraft {
  projectId: string;
  title: string;
  selection: ModelSelection;
  accessMode: AccessMode;
  interactionMode: InteractionMode;
}

export interface MultiSpawnDraft {
  prompt: string;
  sides: [MultiSpawnSideDraft, MultiSpawnSideDraft];
  rememberPreset: boolean;
}

function localCheckoutIdentity(project: Project): string {
  return project.repositoryRoot
    || project.normalizedPath
    || project.path;
}

export function projectsShareLocalCheckout(
  projects: readonly Project[],
  firstProjectId: string,
  secondProjectId: string,
): boolean {
  const first = projects.find(({ id }) => id === firstProjectId);
  const second = projects.find(({ id }) => id === secondProjectId);
  return Boolean(
    first
    && second
    && localCheckoutIdentity(first) === localCheckoutIdentity(second),
  );
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    ? value
    : null;
}

function cloneSelection(selection: ModelSelection): ModelSelection {
  return {
    ...selection,
    providerOptions: { ...selection.providerOptions },
    capabilities: selection.capabilities.map(
      (capability) => ({ ...capability }),
    ),
  };
}

function routeReference(value: unknown): MultiSpawnRouteReference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MultiSpawnRouteReference>;
  const harnessId = boundedString(
    candidate.harnessId,
    MAX_ROUTE_ID_LENGTH,
  );
  const backendProfileId = boundedString(
    candidate.backendProfileId,
    MAX_ROUTE_ID_LENGTH,
  );
  const modelId = boundedString(candidate.modelId, MAX_ROUTE_ID_LENGTH);
  const reasoningEffort = candidate.reasoningEffort === null
    ? null
    : boundedString(candidate.reasoningEffort, MAX_REASONING_LENGTH);
  if (
    !harnessId
    || !backendProfileId
    || !modelId
    || (
      reasoningEffort === null
      && candidate.reasoningEffort !== null
    )
  ) {
    return null;
  }
  return {
    harnessId,
    backendProfileId,
    modelId,
    reasoningEffort,
  };
}

function presetSide(value: unknown): MultiSpawnPresetSide | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MultiSpawnPresetSide>;
  const title = typeof candidate.title === "string"
    ? candidate.title.trim()
    : "";
  const route = routeReference(candidate.route);
  if (
    !title
    || title.length > MAX_TITLE_LENGTH
    || !route
    || !ACCESS_MODES.has(candidate.accessMode as AccessMode)
  ) {
    return null;
  }
  return {
    title,
    route,
    accessMode: candidate.accessMode as AccessMode,
  };
}

export function readMultiSpawnPreset(
  storage: Pick<Storage, "getItem">,
): MultiSpawnPreset | null {
  try {
    const raw = storage.getItem(MULTI_SPAWN_PRESET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      sides?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.sides)) return null;
    const first = presetSide(parsed.sides[0]);
    const second = presetSide(parsed.sides[1]);
    if (!first || !second || parsed.sides.length !== 2) return null;
    return { version: 1, sides: [first, second] };
  } catch {
    return null;
  }
}

export function writeMultiSpawnPreset(
  storage: Pick<Storage, "setItem">,
  draft: MultiSpawnDraft,
): boolean {
  const preset: MultiSpawnPreset = {
    version: 1,
    sides: draft.sides.map((side) => ({
      title: side.title.trim(),
      route: {
        harnessId: side.selection.harnessId,
        backendProfileId: side.selection.backendProfileId,
        modelId: side.selection.modelId,
        reasoningEffort: side.selection.reasoningEffort,
      },
      accessMode: side.accessMode,
    })) as [MultiSpawnPresetSide, MultiSpawnPresetSide],
  };
  try {
    storage.setItem(
      MULTI_SPAWN_PRESET_STORAGE_KEY,
      JSON.stringify(preset),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearMultiSpawnPreset(
  storage: Pick<Storage, "removeItem">,
): boolean {
  try {
    storage.removeItem(MULTI_SPAWN_PRESET_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function defaultSelectionForProject(
  snapshot: AppSnapshot,
  settings: AppSettings,
  projectId: string,
): ModelSelection {
  const backendDefault = snapshot.backendDefaults?.find(
    ({ scope, projectId: scopedProjectId }) =>
      scope === "project" && scopedProjectId === projectId,
  ) ?? snapshot.backendDefaults?.find(({ scope }) => scope === "global");
  if (backendDefault) {
    return cloneSelection(backendDefault.selection);
  }
  return nativeModelSelection({
    providerId: settings.defaultProvider,
    modelId: settings.defaultModel || "provider-default",
    alias: settings.defaultModel || null,
    reasoningEffort: settings.defaultReasoningEffort || null,
  });
}

function matchingPresetRoute(
  routes: readonly ComposerModelRoute[],
  reference: MultiSpawnRouteReference,
): ComposerModelRoute | null {
  return routes.find((route) =>
    route.selectable
    && route.harnessId === reference.harnessId
    && route.backendProfileId === reference.backendProfileId
    && route.modelId === reference.modelId) ?? null;
}

export function selectionFromPreset(
  routes: readonly ComposerModelRoute[],
  reference: MultiSpawnRouteReference,
  fallback: ModelSelection,
): ModelSelection {
  const route = matchingPresetRoute(routes, reference);
  if (!route) return cloneSelection(fallback);
  const reasoningEffort = (
    reference.reasoningEffort === null
    || route.reasoningOptions.includes(reference.reasoningEffort)
  )
    ? reference.reasoningEffort
    : route.selection.reasoningEffort;
  return cloneSelection({
    ...route.selection,
    reasoningEffort,
  });
}

export function initialMultiSpawnDraft(input: {
  snapshot: AppSnapshot;
  settings: AppSettings;
  activeProjectId: string;
  routesForSelection: (
    selection: ModelSelection,
  ) => readonly ComposerModelRoute[];
  preset: MultiSpawnPreset | null;
}): MultiSpawnDraft {
  const fallback = defaultSelectionForProject(
    input.snapshot,
    input.settings,
    input.activeProjectId,
  );
  const side = (
    index: 0 | 1,
    defaultTitle: string,
  ): MultiSpawnSideDraft => {
    const saved = input.preset?.sides[index];
    const selection = saved
      ? selectionFromPreset(
          input.routesForSelection(fallback),
          saved.route,
          fallback,
        )
      : cloneSelection(fallback);
    return {
      projectId: input.activeProjectId,
      title: saved?.title ?? defaultTitle,
      selection,
      accessMode: saved?.accessMode ?? input.settings.defaultAccessMode,
      interactionMode: input.settings.defaultInteractionMode,
    };
  };
  return {
    prompt: "",
    sides: [
      side(0, "First perspective"),
      side(1, "Second perspective"),
    ],
    rememberPreset: Boolean(input.preset),
  };
}

export function multiSpawnConversationPayload(
  side: MultiSpawnSideDraft,
  settings: AppSettings,
): NewConversationPayload {
  const providerId = legacyProviderIdForHarness(side.selection.harnessId);
  if (!providerId) {
    throw new Error("That agent harness is unavailable in this build.");
  }
  return {
    ...withNewConversationModelSelection(
      buildNewConversationPayload(side.projectId, settings),
      side.selection,
    ),
    title: side.title.trim(),
    providerId,
    interactionMode: side.interactionMode,
    accessMode: side.accessMode,
    activate: false,
  };
}

export function validateMultiSpawnDraft(
  draft: MultiSpawnDraft,
): string | null {
  if (!draft.prompt.trim()) return "Write one prompt for both chats.";
  if (draft.prompt.trim().length > 20_000) {
    return "The shared prompt must be 20,000 characters or fewer.";
  }
  for (const [index, side] of draft.sides.entries()) {
    const title = side.title.trim();
    if (!title) return `Name chat ${index + 1}.`;
    if (title.length > MAX_TITLE_LENGTH) {
      return `Chat ${index + 1} name must be ${MAX_TITLE_LENGTH} characters or fewer.`;
    }
    if (!side.projectId) return `Choose a project for chat ${index + 1}.`;
  }
  return null;
}
