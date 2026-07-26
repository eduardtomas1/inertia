import {
  isKimiCodingModelId,
  kimiCodingModelDisplayName,
} from "../../../shared/claude-backend-profiles";
import type { ModelSelection } from "../../../shared/model-routing";

const HARNESS_LABELS: Readonly<Record<string, string>> = {
  "codex-app-server": "Codex",
  "codex-cli": "Codex",
  "claude-agent-sdk": "Claude",
  "claude-cli": "Claude",
  "cursor-acp": "Cursor",
  "cursor-cli": "Cursor",
  "opencode-sdk": "OpenCode",
  "opencode-cli": "OpenCode",
};

function persistedModelLabel(selection: ModelSelection): string {
  if (selection.alias) return selection.alias;
  if (selection.modelId === "provider-default") return "Provider default";
  if (isKimiCodingModelId(selection.modelId)) {
    return kimiCodingModelDisplayName(selection.modelId);
  }
  return selection.modelId;
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
    selection.backendProfileDisplayName,
    persistedModelLabel(selection),
  ].join(" · ");
}
