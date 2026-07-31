import { KNOWN_HARNESS_IDS, type HarnessId } from "./model-routing";

export type RemoteNetworkPolicy =
  | "disabled"
  | "local-approval"
  | "provider-controlled"
  | "unrestricted";

export type RemoteFilesystemPolicy =
  | "read-only-sandbox"
  | "local-approval"
  | "provider-controlled"
  | "unrestricted";

export type RemotePermissionModel =
  | "inertia-enforced"
  | "provider-reported"
  | "provider-controlled";

export interface RemotePromptSafety {
  supported: boolean;
  writesRequireLocalApproval: boolean;
  commandsRequireLocalApproval: boolean;
  networkPolicy: RemoteNetworkPolicy;
  filesystemPolicy: RemoteFilesystemPolicy;
  permissionModel: RemotePermissionModel;
  headline: string;
  explanation: string;
}

export const UNSUPPORTED_REMOTE_PROMPT_SAFETY: RemotePromptSafety =
  Object.freeze({
    supported: false,
    writesRequireLocalApproval: false,
    commandsRequireLocalApproval: false,
    networkPolicy: "provider-controlled",
    filesystemPolicy: "provider-controlled",
    permissionModel: "provider-controlled",
    headline: "Remote prompts unavailable",
    explanation:
      "This agent does not advertise a remote prompt safety contract, so "
      + "Inertia refuses remote prompts for it.",
  });

const APPROVAL_ROUTED: RemotePromptSafety = Object.freeze({
  supported: true,
  writesRequireLocalApproval: true,
  commandsRequireLocalApproval: true,
  networkPolicy: "provider-controlled",
  filesystemPolicy: "local-approval",
  permissionModel: "provider-reported",
  headline: "Local approval required for reported actions",
  explanation:
    "The agent reports each tool action to Inertia, which requires a desktop "
    + "approval before it proceeds. Inertia can only gate the actions the "
    + "agent chooses to report; this is not an operating-system sandbox.",
});

const REMOTE_PROMPT_SAFETY: Readonly<Record<string, RemotePromptSafety>> =
  Object.freeze({
    "codex-app-server": {
      ...APPROVAL_ROUTED,
      permissionModel: "provider-reported",
      headline: "Provider-controlled reads · Local approval required for reported actions",
      explanation:
        "Codex reports command and patch approvals to Inertia over its app "
        + "server protocol, and a supervised conversation requires a desktop "
        + "decision for each one. Codex owns its own sandbox configuration, so "
        + "Inertia does not claim a filesystem or network guarantee of its own.",
    },
    "claude-agent-sdk": {
      ...APPROVAL_ROUTED,
      headline: "Provider-reported tools · Local approval required",
      explanation:
        "The Claude Agent SDK routes every tool use through Inertia's "
        + "canUseTool callback, so a supervised conversation requires a desktop "
        + "decision before a write or command runs. Reads that the SDK does not "
        + "surface as tool uses are provider-controlled.",
    },
    "cursor-acp": {
      ...APPROVAL_ROUTED,
      headline: "Provider-controlled reads · Local approval required for reported actions",
      explanation:
        "Cursor reports permission requests over the Agent Client Protocol and "
        + "a supervised conversation requires a desktop decision for each one. "
        + "Cursor decides what it reports, so this is not a sandbox.",
    },
    "opencode-sdk": {
      ...APPROVAL_ROUTED,
      permissionModel: "inertia-enforced",
      headline: "Ask-by-default permissions · Local approval required",
      explanation:
        "Inertia installs an ask-by-default OpenCode permission ruleset for "
        + "supervised conversations, so edits and commands need a desktop "
        + "decision. OpenCode still executes the work in its own process "
        + "without an operating-system sandbox.",
    },
    "codex-cli": {
      ...UNSUPPORTED_REMOTE_PROMPT_SAFETY,
      explanation:
        "The Codex CLI harness cannot deliver approvals to Inertia, so a "
        + "remote prompt could run unapproved actions. Remote prompts are "
        + "refused for it.",
    },
    "claude-cli": {
      ...UNSUPPORTED_REMOTE_PROMPT_SAFETY,
      explanation:
        "The Claude CLI harness cannot deliver approvals to Inertia, so a "
        + "remote prompt could run unapproved actions. Remote prompts are "
        + "refused for it.",
    },
    "cursor-cli": {
      ...UNSUPPORTED_REMOTE_PROMPT_SAFETY,
      explanation:
        "The Cursor CLI harness cannot deliver approvals to Inertia, so a "
        + "remote prompt could run unapproved actions. Remote prompts are "
        + "refused for it.",
    },
    "opencode-cli": {
      ...UNSUPPORTED_REMOTE_PROMPT_SAFETY,
      explanation:
        "The OpenCode CLI harness cannot deliver approvals to Inertia, so a "
        + "remote prompt could run unapproved actions. Remote prompts are "
        + "refused for it.",
    },
  });

export function remotePromptSafetyForHarness(
  harnessId: HarnessId | null | undefined,
): RemotePromptSafety {
  if (typeof harnessId !== "string") return UNSUPPORTED_REMOTE_PROMPT_SAFETY;
  return REMOTE_PROMPT_SAFETY[harnessId] ?? UNSUPPORTED_REMOTE_PROMPT_SAFETY;
}

export function remotePromptSafetyIsUsable(
  safety: RemotePromptSafety | null | undefined,
): boolean {
  if (!safety || safety.supported !== true) return false;
  if (!safety.writesRequireLocalApproval) return false;
  if (!safety.commandsRequireLocalApproval) return false;
  if (safety.networkPolicy === "unrestricted") return false;
  if (safety.filesystemPolicy === "unrestricted") return false;
  return safety.permissionModel !== "provider-controlled";
}

export function remotePromptSafetyLabel(
  providerName: string,
  safety: RemotePromptSafety,
): string {
  return `${providerName} remote prompt\n${safety.headline}`;
}

export const REMOTE_PROMPT_SAFETY_HARNESS_IDS: readonly string[] =
  KNOWN_HARNESS_IDS;
