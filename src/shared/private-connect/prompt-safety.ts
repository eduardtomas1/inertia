import { KNOWN_HARNESS_IDS, type HarnessId } from "../model-routing";

export type PrivateConnectNetworkPolicy =
  | "disabled"
  | "local-approval"
  | "provider-controlled"
  | "unrestricted";

export type PrivateConnectFilesystemPolicy =
  | "read-only-sandbox"
  | "local-approval"
  | "provider-controlled"
  | "unrestricted";

export type PrivateConnectPermissionModel =
  | "inertia-enforced"
  | "provider-reported"
  | "provider-controlled";

export interface PrivateConnectPromptSafety {
  supported: boolean;
  writesRequireLocalApproval: boolean;
  commandsRequireLocalApproval: boolean;
  networkPolicy: PrivateConnectNetworkPolicy;
  filesystemPolicy: PrivateConnectFilesystemPolicy;
  permissionModel: PrivateConnectPermissionModel;
  headline: string;
  explanation: string;
}

export const UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY: PrivateConnectPromptSafety =
  Object.freeze({
    supported: false,
    writesRequireLocalApproval: false,
    commandsRequireLocalApproval: false,
    networkPolicy: "provider-controlled",
    filesystemPolicy: "provider-controlled",
    permissionModel: "provider-controlled",
    headline: "Private Connect prompts unavailable",
    explanation:
      "This agent does not advertise a Private Connect prompt safety contract, so "
      + "Inertia refuses Private Connect prompts for it.",
  });

const APPROVAL_ROUTED: PrivateConnectPromptSafety = Object.freeze({
  supported: true,
  writesRequireLocalApproval: true,
  commandsRequireLocalApproval: true,
  networkPolicy: "provider-controlled",
  filesystemPolicy: "provider-controlled",
  permissionModel: "provider-reported",
  headline: "Local approval required for reported actions",
  explanation:
    "The agent reports each tool action to Inertia, which requires a desktop "
    + "approval before it proceeds. Project reads remain provider-controlled, "
    + "and Private Connect answers can include project-derived text. Inertia can only "
    + "gate the actions the agent reports; this is not an operating-system sandbox.",
});

const PRIVATE_CONNECT_PROMPT_SAFETY: Readonly<Record<string, PrivateConnectPromptSafety>> =
  Object.freeze({
    "codex-app-server": {
      ...APPROVAL_ROUTED,
      permissionModel: "provider-reported",
      headline: "Provider-controlled reads · Local approval required for reported actions",
      explanation:
        "Codex reports command and patch approvals to Inertia over its app "
        + "server protocol, and a supervised conversation requires a desktop "
        + "decision for each reported write or command. Codex controls project "
        + "reads, and its Private Connect answer can include project-derived text. Inertia "
        + "does not claim a filesystem or network guarantee of its own.",
    },
    "claude-agent-sdk": {
      ...APPROVAL_ROUTED,
      headline: "Provider-reported tools · Local approval required",
      explanation:
        "The Claude Agent SDK routes every tool use through Inertia's "
        + "canUseTool callback, so a supervised conversation requires a desktop "
        + "decision before a write or command runs. Project reads are provider-"
        + "controlled, and the Private Connect answer can include project-derived text.",
    },
    "cursor-acp": {
      ...APPROVAL_ROUTED,
      headline: "Provider-controlled reads · Local approval required for reported actions",
      explanation:
        "Cursor reports permission requests over the Agent Client Protocol and "
        + "a supervised conversation requires a desktop decision for each reported "
        + "write or command. Cursor controls project reads, and the Private Connect answer "
        + "can include project-derived text, so this is not a sandbox.",
    },
    "opencode-sdk": {
      ...APPROVAL_ROUTED,
      permissionModel: "inertia-enforced",
      headline: "Ask-by-default permissions · Local approval required",
      explanation:
        "Inertia installs an ask-by-default OpenCode permission ruleset for "
        + "supervised conversations, so edits and commands need a desktop "
        + "decision. OpenCode still controls project reads and can return project-"
        + "derived text through Private Connect; it executes without an operating-system sandbox.",
    },
    "codex-cli": {
      ...UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
      explanation:
        "The Codex CLI harness cannot deliver approvals to Inertia, so a "
        + "Private Connect prompt could run unapproved actions. Private Connect prompts are "
        + "refused for it.",
    },
    "claude-cli": {
      ...UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
      explanation:
        "The Claude CLI harness cannot deliver approvals to Inertia, so a "
        + "Private Connect prompt could run unapproved actions. Private Connect prompts are "
        + "refused for it.",
    },
    "cursor-cli": {
      ...UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
      explanation:
        "The Cursor CLI harness cannot deliver approvals to Inertia, so a "
        + "Private Connect prompt could run unapproved actions. Private Connect prompts are "
        + "refused for it.",
    },
    "opencode-cli": {
      ...UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
      explanation:
        "The OpenCode CLI harness cannot deliver approvals to Inertia, so a "
        + "Private Connect prompt could run unapproved actions. Private Connect prompts are "
        + "refused for it.",
    },
  });

export function privateConnectPromptSafetyForHarness(
  harnessId: HarnessId | null | undefined,
): PrivateConnectPromptSafety {
  if (typeof harnessId !== "string") return UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY;
  return PRIVATE_CONNECT_PROMPT_SAFETY[harnessId] ?? UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY;
}

export function privateConnectPromptSafetyIsUsable(
  safety: PrivateConnectPromptSafety | null | undefined,
): boolean {
  if (!safety || safety.supported !== true) return false;
  if (!safety.writesRequireLocalApproval) return false;
  if (!safety.commandsRequireLocalApproval) return false;
  if (safety.networkPolicy === "unrestricted") return false;
  if (safety.filesystemPolicy === "unrestricted") return false;
  return safety.permissionModel !== "provider-controlled";
}

export function privateConnectPromptSafetyLabel(
  providerName: string,
  safety: PrivateConnectPromptSafety,
): string {
  return `${providerName} Private Connect prompt\n${safety.headline}`;
}

export const PRIVATE_CONNECT_PROMPT_SAFETY_HARNESS_IDS: readonly string[] =
  KNOWN_HARNESS_IDS;
