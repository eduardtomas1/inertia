import type { CursorSdkModel } from "@shared/cursor-sdk-models";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  providerNativeBackendProfile,
  resolveHarnessBackendCompatibility,
} from "@shared/model-routing";
import type { ComposerModelRoute } from "../../utils/modelChooserRoutes";

export function cursorSdkModelRoute(model: CursorSdkModel): ComposerModelRoute | null {
  if (!model.id.trim() || ["default", "provider-default"].includes(model.id)) return null;
  const backend = providerNativeBackendProfile("cursor");
  const selection = modelSelectionSchema.parse({
    harnessId: "cursor-sdk",
    backendProfileId: backend.id,
    backendProfileDisplayName: backend.displayName,
    backendConfigurationRevision: backend.configurationRevision,
    modelId: model.id,
    alias: null,
    reasoningEffort: null,
    contextWindowOverride: null,
    providerOptions: {},
    capabilities: [],
  });
  const compatibility = resolveHarnessBackendCompatibility("cursor-sdk", backend);
  return {
    key: JSON.stringify([selection.harnessId, selection.backendProfileId, selection.modelId]),
    displayName: model.displayName,
    modelId: model.id,
    alias: null,
    harnessId: "cursor-sdk",
    harnessLabel: "Cursor SDK",
    backendProfileId: backend.id,
    backendProfileName: "Cursor SDK",
    backendConfigurationRevision: selection.backendConfigurationRevision,
    providerLabel: "Cursor SDK",
    source: "built-in",
    sourceProviderId: "cursor",
    routeKind: "account",
    routeLabel: "Cursor SDK",
    routeTerms: ["cursor-sdk"],
    selectable: compatibility.state === "verified",
    unavailableReason: compatibility.state === "verified" ? null : compatibility.reason,
    selection,
    continuationIdentity: continuationIdentityForSelection(selection, backend.endpointIdentity, true),
    compatibility,
    rowCompatibility: null,
    providerId: "cursor",
    providerReady: true,
    reasoningEffort: null,
    reasoningOptions: [],
  };
}
