import {
  isKimiCodingModelId,
  kimiCodingModelDisplayName,
} from "../../../shared/claude-backend-profiles";
import {
  providerIdForHarness,
  type ModelSelection,
} from "../../../shared/model-routing";
import type { ProviderIdentityLabels } from "../../../shared/provider-identities";

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  "codex-app-server": "Codex",
  "codex-cli": "Codex",
  "claude-agent-sdk": "Claude",
  "claude-cli": "Claude",
  "cursor-acp": "Cursor",
  "cursor-cli": "Cursor",
  "gemini-acp": "Gemini",
  "kimi-acp": "Kimi Code",
  "opencode-sdk": "OpenCode",
  "opencode-cli": "OpenCode",
};

const STRUCTURAL_BACKEND_LABELS: Readonly<Record<string, string>> = {
  "builtin:openai": "OpenAI",
  "native:codex:app-server": "OpenAI",
  "builtin:anthropic": "Anthropic",
  "builtin:kimi-code": "Kimi",
  "builtin:cursor": "Cursor",
  "builtin:gemini": "Google Gemini",
  "builtin:kimi": "Kimi Code",
  "builtin:opencode": "OpenCode",
};

function persistedBackendLabel(selection: ModelSelection): string {
  return STRUCTURAL_BACKEND_LABELS[selection.backendProfileId]
    ?? selection.backendProfileDisplayName;
}

function persistedModelLabel(selection: ModelSelection): string {
  if (selection.alias) return selection.alias;
  if (selection.modelId === "provider-default") return "Provider default";
  if (isKimiCodingModelId(selection.modelId)) {
    return kimiCodingModelDisplayName(selection.modelId);
  }
  return selection.modelId;
}

/**
 * Operational identity for an active turn. The active work header deliberately
 * stops at the persisted harness/backend route; the exact model remains
 * available in the final-answer identity and run details.
 */
export function activeWorkIdentityLabel(
  selection: ModelSelection,
  providerIdentityLabels: ProviderIdentityLabels = {},
): string {
  const providerId = providerIdForHarness(selection.harnessId);
  const harness = (providerId && providerIdentityLabels[providerId])
    ?? HARNESS_LABELS[selection.harnessId]
    ?? selection.harnessId;
  return `${harness} · ${selection.backendProfileDisplayName}`;
}

/**
 * Editorial identity for a historical answer. Every segment comes from the
 * persisted ModelSelection; current provider catalogs and backend settings are
 * intentionally not inputs.
 */
export function finalAnswerIdentityLabel(selection: ModelSelection): string {
  const harness = HARNESS_LABELS[selection.harnessId] ?? selection.harnessId;
  return [
    harness,
    persistedBackendLabel(selection),
    persistedModelLabel(selection),
  ].join(" · ");
}
