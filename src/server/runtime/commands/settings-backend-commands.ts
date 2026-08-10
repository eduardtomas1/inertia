import { isAbsolute } from "node:path";

import type WebSocket from "ws";

import type {
  ProviderInfo,
  ServerEvent,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProviderManager } from "../../providers";
import { RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface SettingsBackendCommandDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  defaultWorkspacePath: string;
  refreshProviderInfo(
    providerId?: ProviderInfo["id"],
    refreshEnvironment?: boolean,
    forceMetadata?: boolean,
  ): Promise<void>;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createSettingsBackendCommandHandler(
  dependencies: SettingsBackendCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "settings.update",
    "prompt-preset.create",
    "prompt-preset.update",
    "prompt-preset.duplicate",
    "prompt-preset.delete",
    "prompt-preset.reorder",
    "backend.profile.get",
    "backend.profile.create",
    "backend.profile.update",
    "backend.profile.credential-revision",
    "backend.profile.probe",
    "backend.profile.delete",
    "backend.default.set",
    "backend.default.clear",
  ], async (socket, command) => {
    switch (command.type) {
      case "settings.update": {
        if (command.payload.codexBinaryPath !== undefined) {
          const manualPath = command.payload.codexBinaryPath.trim();
          if (manualPath) {
            if (!isAbsolute(manualPath)) {
              throw new RuntimeRequestError(
                "Choose an absolute Codex executable path.",
              );
            }
            const detection = await dependencies.providers.validateCommand(
              "codex",
              manualPath,
              {
                cwd: dependencies.defaultWorkspacePath,
                timeoutMs: 4_000,
                refreshEnvironment: true,
              },
            );
            if (
              detection.installState !== "installed"
              || !detection.version
            ) {
              throw new RuntimeRequestError(
                "The selected file is not a working Codex executable.",
              );
            }
          }
          dependencies.providers.setCommand(
            "codex",
            manualPath || undefined,
          );
        }
        dependencies.store.updateSettings(command.payload);
        if (command.payload.codexBinaryPath !== undefined) {
          await dependencies.refreshProviderInfo("codex", true, true);
        }
        return "mutation";
      }
      case "prompt-preset.create":
        dependencies.store.promptPresets.create(
          command.payload,
        );
        return "mutation";
      case "prompt-preset.update": {
        const {
          presetId,
          expectedRevision,
          ...update
        } = command.payload;
        dependencies.store.promptPresets.update(
          presetId,
          expectedRevision,
          update,
        );
        return "mutation";
      }
      case "prompt-preset.duplicate":
        dependencies.store.promptPresets.duplicate(
          command.payload.presetId,
          command.payload.expectedRevision,
        );
        return "mutation";
      case "prompt-preset.delete":
        dependencies.store.promptPresets.delete(
          command.payload.presetId,
          command.payload.expectedRevision,
        );
        return "mutation";
      case "prompt-preset.reorder":
        dependencies.store.promptPresets.reorder(
          command.payload.expectedPresetIds,
          command.payload.presetIds,
        );
        return "mutation";
      case "backend.profile.get":
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "backend.profile",
            profile: dependencies.backendProfileController.detail(
              command.payload.profileId,
            ),
          },
        });
        return "handled";
      case "backend.profile.create": {
        const profile = await dependencies.backendProfileController
          .createProfile(command.payload);
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "backend.profile", profile },
        });
        return "handled";
      }
      case "backend.profile.update": {
        const profile = await dependencies.backendProfileController
          .updateProfile(
            command.payload.profileId,
            command.payload.update,
          );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "backend.profile", profile },
        });
        return "handled";
      }
      case "backend.profile.credential-revision": {
        const profile = await dependencies.backendProfileController
          .reconcileCredentialRevision(
            command.payload.profileId,
            command.payload.credentialGeneration,
          );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "backend.profile", profile },
        });
        return "handled";
      }
      case "backend.profile.probe": {
        const profile = await dependencies.backendProfileController.probe(
          command.payload.profileId,
          command.payload.modelId,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "backend.profile.probe", profile },
        });
        return "handled";
      }
      case "backend.profile.delete":
        await dependencies.backendProfileController.deleteProfile(
          command.payload.profileId,
        );
        return "mutation";
      case "backend.default.set": {
        const value = dependencies.backendProfileController.setDefault(
          command.payload.projectId,
          command.payload.selection,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "backend.default", value },
        });
        return "handled";
      }
      case "backend.default.clear":
        dependencies.backendProfileController.clearDefault(
          command.payload.projectId,
        );
        return "mutation";
      default:
        return "not-handled";
    }
  });
}
