import type { ProviderInfo } from "../../../shared/contracts";
import type { ModelSelection } from "../../../shared/model-routing";
import { BackendProfileControllerError } from "./backend-profile-types";

export const CODEX_REASONING_SUMMARY_VALUES = [
  "auto",
  "concise",
  "detailed",
  "none",
] as const;

export type CodexReasoningSummaryValue =
  (typeof CODEX_REASONING_SUMMARY_VALUES)[number];

export function isCodexReasoningSummaryValue(
  value: unknown,
): value is CodexReasoningSummaryValue {
  return typeof value === "string"
    && (CODEX_REASONING_SUMMARY_VALUES as readonly string[]).includes(value);
}

export function validateNativeProviderOptions(
  providerId: ProviderInfo["id"],
  model: ProviderInfo["models"][number] | undefined,
  selection: ModelSelection,
): void {
  const keys = Object.keys(selection.providerOptions);
  if (keys.length === 0) return;

  for (const key of keys) {
    if (key !== "fastMode" && key !== "reasoningSummary") {
      throw new BackendProfileControllerError(
        "The native provider options are invalid.",
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(selection.providerOptions, "fastMode")) {
    const fastMode = selection.providerOptions.fastMode;
    if (typeof fastMode !== "string") {
      throw new BackendProfileControllerError(
        "The native provider options are invalid.",
      );
    }
    if (providerId !== "codex" && providerId !== "claude") {
      throw new BackendProfileControllerError(
        "This provider does not expose a supported Fast mode.",
      );
    }
    const expectedProviderValue = providerId === "codex" ? "priority" : "fast";
    if (
      !model?.fastMode
      || model.fastMode.providerValue !== expectedProviderValue
      || fastMode !== model.fastMode.providerValue
    ) {
      throw new BackendProfileControllerError(
        `${model?.label ?? selection.modelId} does not currently advertise Fast mode. Choose Standard or refresh provider models.`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(selection.providerOptions, "reasoningSummary")) {
    const reasoningSummary = selection.providerOptions.reasoningSummary;
    if (providerId !== "codex" || !isCodexReasoningSummaryValue(reasoningSummary)) {
      throw new BackendProfileControllerError(
        "The native provider options are invalid.",
      );
    }
  }
}
