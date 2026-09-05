export type ChangeDomain =
  | "quality_shared"
  | "runtime_supervisor"
  | "process_containment"
  | "startup_recovery"
  | "provider_common"
  | "provider_codex"
  | "provider_claude"
  | "provider_cursor"
  | "provider_gemini"
  | "provider_kimi"
  | "provider_opencode"
  | "turn_session"
  | "agent_management"
  | "database_migrations"
  | "terminal_native"
  | "updater"
  | "windows_packaging"
  | "linux_appimage"
  | "macos_packaging"
  | "renderer_ui"
  | "performance"
  | "ci_test_infrastructure";

export interface ChangeClassification {
  allEvidence: boolean;
  fullCertification: boolean;
  documentationOnly: boolean;
  domains: ChangeDomain[];
  reasons: string[];
}

export const CHANGE_DOMAINS: readonly ChangeDomain[];

export function classifyChangedPaths(inputPaths: readonly string[]): ChangeClassification;

export function githubOutputsForClassification(classification: ChangeClassification): string;
