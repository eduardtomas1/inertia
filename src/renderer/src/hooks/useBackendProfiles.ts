import { useCallback } from "react";
import type {
  BackendDiscoveredModel,
  ModelBackendProfileCreateDraft,
  ModelBackendProfileDetail,
  ModelSelection,
  ServerEvent,
} from "@shared/contracts";
import {
  backendProfileCreatePayload,
  backendProfileUpdatePayload,
  type BackendProfileUpdateInput,
} from "../lib/backendProfileCommands";
import { ELECTRON_IPC_ERROR_PREFIX } from "./useDesktopTools";
import {
  resultEvent,
  type CommandWithoutId,
} from "../lib/runtimeCommands";

interface BackendProfilesOptions {
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId, options?: { reportError?: boolean }) => Promise<ServerEvent>;
}

function backendProfileResult(event: ServerEvent): ModelBackendProfileDetail {
  const result = resultEvent(event).result;
  if (
    result.kind !== "backend.profile"
    && result.kind !== "backend.profile.probe"
  ) {
    throw new Error(
      "The local service returned an unexpected backend profile response.",
    );
  }
  if (
    result.kind === "backend.profile"
    && result.credentialCleared === true
    && result.profile.authState !== "missing"
  ) {
    return { ...result.profile, authState: "missing" };
  }
  return result.profile;
}

function discoveredModelsResult(
  event: ServerEvent,
  profileId: string,
): BackendDiscoveredModel[] {
  const result = resultEvent(event).result;
  if (result.kind !== "backend.profile.models" || result.profileId !== profileId) {
    throw new Error(
      "The local service returned an unexpected model list.",
    );
  }
  return result.models.map(({ id, displayName }) => ({ id, displayName }));
}

const quiet = { reportError: false } as const;

export type BackendProbeOutcome = ModelBackendProfileDetail & {
  skippedModelIds?: readonly string[];
};

function skippedProbeModelIds(result: object): string[] {
  const value = (result as { skippedModelIds?: unknown }).skippedModelIds;
  return Array.isArray(value)
    ? value.filter((modelId): modelId is string => typeof modelId === "string")
    : [];
}

async function withoutIpcPrefix<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (reason) {
    if (!(reason instanceof Error)) throw reason;
    const message = reason.message.replace(ELECTRON_IPC_ERROR_PREFIX, "").trim();
    throw new Error(message || "The credential vault could not be reached.");
  }
}

export function useBackendProfiles({
  request,
  run,
}: BackendProfilesOptions) {
  const loadBackendProfile = useCallback(async (
    profileId: string,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await request({
      type: "backend.profile.get",
      payload: { profileId },
    })), [request]);

  const createBackendProfile = useCallback(async (
    draft: ModelBackendProfileCreateDraft,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.create", {
      type: "backend.profile.create",
      payload: backendProfileCreatePayload(draft),
    }, quiet)), [run]);

  const updateBackendProfile = useCallback(async (
    profileId: string,
    update: BackendProfileUpdateInput,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.update", {
      type: "backend.profile.update",
      payload: {
        profileId,
        update: backendProfileUpdatePayload(update),
      },
    }, quiet)), [run]);

  const reconcileBackendCredential = useCallback(async (
    profileId: string,
    credentialGeneration: string | null,
  ): Promise<ModelBackendProfileDetail> => {
    if (!credentialGeneration) {
      throw new Error(
        "Secure credential storage did not return a mutation generation.",
      );
    }
    return backendProfileResult(await run(
      "backend.profile.credential-revision",
      {
        type: "backend.profile.credential-revision",
        payload: { profileId, credentialGeneration },
      },
      quiet,
    ));
  }, [run]);

  const setBackendCredential = useCallback(async (
    profileId: string,
    secret: string,
  ): Promise<ModelBackendProfileDetail> => {
    const state = await withoutIpcPrefix(() => window.inertia.setBackendCredential({
      profileId,
      secret,
    }));
    return reconcileBackendCredential(
      profileId,
      state.credentialGeneration,
    );
  }, [reconcileBackendCredential]);

  const clearBackendCredential = useCallback(async (
    profileId: string,
  ): Promise<ModelBackendProfileDetail> => {
    const state = await withoutIpcPrefix(() => window.inertia.clearBackendCredential({ profileId }));
    return reconcileBackendCredential(
      profileId,
      state.credentialGeneration,
    );
  }, [reconcileBackendCredential]);

  const probeBackendProfile = useCallback(async (
    profileId: string,
    modelIds?: readonly string[],
  ): Promise<BackendProbeOutcome> => {
    const event = await run("backend.profile.probe", {
      type: "backend.profile.probe",
      payload: modelIds !== undefined
        ? { profileId, modelIds: [...modelIds] }
        : { profileId },
    }, quiet);
    const profile = backendProfileResult(event);
    const skipped = skippedProbeModelIds(resultEvent(event).result);
    return skipped.length > 0 ? { ...profile, skippedModelIds: skipped } : profile;
  }, [run]);

  const discoverBackendModels = useCallback(async (
    profileId: string,
  ): Promise<BackendDiscoveredModel[]> =>
    discoveredModelsResult(await run("backend.profile.discover-models", {
      type: "backend.profile.discover-models",
      payload: { profileId },
    }, quiet), profileId), [run]);

  const deleteBackendProfile = useCallback(async (
    profileId: string,
  ): Promise<void> => {
    await run("backend.profile.delete", {
      type: "backend.profile.delete",
      payload: { profileId },
    }, quiet);
  }, [run]);

  const setBackendDefault = useCallback(async (
    projectId: string | null,
    selection: ModelSelection,
  ): Promise<void> => {
    await run("backend.default.set", {
      type: "backend.default.set",
      payload: {
        projectId,
        selection: {
          ...selection,
          providerOptions: { ...selection.providerOptions },
          capabilities: selection.capabilities.map((capability) => ({
            ...capability,
          })),
        },
      },
    }, { reportError: false });
  }, [run]);

  const clearBackendDefault = useCallback(async (
    projectId: string | null,
  ): Promise<void> => {
    await run("backend.default.clear", {
      type: "backend.default.clear",
      payload: { projectId },
    });
  }, [run]);

  return {
    loadBackendProfile,
    createBackendProfile,
    updateBackendProfile,
    setBackendCredential,
    clearBackendCredential,
    probeBackendProfile,
    discoverBackendModels,
    deleteBackendProfile,
    setBackendDefault,
    clearBackendDefault,
  };
}
