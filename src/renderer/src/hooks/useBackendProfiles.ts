import { useCallback } from "react";
import type {
  ModelBackendProfileDetail,
  ModelBackendProfileDraft,
  ModelSelection,
  ServerEvent,
} from "@shared/contracts";
import {
  backendProfileCreatePayload,
  backendProfileUpdatePayload,
} from "../lib/backendProfileCommands";
import {
  resultEvent,
  type CommandWithoutId,
} from "../lib/runtimeCommands";

interface BackendProfilesOptions {
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
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
  return result.profile;
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
    draft: ModelBackendProfileDraft,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.create", {
      type: "backend.profile.create",
      payload: backendProfileCreatePayload(draft),
    })), [run]);

  const updateBackendProfile = useCallback(async (
    profileId: string,
    update: Partial<ModelBackendProfileDraft> & { enabled?: boolean },
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.update", {
      type: "backend.profile.update",
      payload: {
        profileId,
        update: backendProfileUpdatePayload(update),
      },
    })), [run]);

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
    ));
  }, [run]);

  const setBackendCredential = useCallback(async (
    profileId: string,
    secret: string,
  ): Promise<ModelBackendProfileDetail> => {
    const state = await window.inertia.setBackendCredential({
      profileId,
      secret,
    });
    return reconcileBackendCredential(
      profileId,
      state.credentialGeneration,
    );
  }, [reconcileBackendCredential]);

  const clearBackendCredential = useCallback(async (
    profileId: string,
  ): Promise<ModelBackendProfileDetail> => {
    const state = await window.inertia.clearBackendCredential({ profileId });
    return reconcileBackendCredential(
      profileId,
      state.credentialGeneration,
    );
  }, [reconcileBackendCredential]);

  const probeBackendProfile = useCallback(async (
    profileId: string,
    modelId: string,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.probe", {
      type: "backend.profile.probe",
      payload: { profileId, modelId },
    })), [run]);

  const deleteBackendProfile = useCallback(async (
    profileId: string,
  ): Promise<void> => {
    await run("backend.profile.delete", {
      type: "backend.profile.delete",
      payload: { profileId },
    });
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
    });
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
    deleteBackendProfile,
    setBackendDefault,
    clearBackendDefault,
  };
}
