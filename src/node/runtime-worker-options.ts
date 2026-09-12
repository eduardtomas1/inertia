import type { ClaudeCompatibleBackendProfile } from "../shared/claude-backend-profiles";
import type { RuntimeRecoveryWorkerOptions } from "./runtime-recovery-process-protocol";
import type { WindowsTerminalAuthority } from "./windows-terminal-authority";

export interface RuntimeWorkerOptions extends RuntimeRecoveryWorkerOptions {
  windowsTerminalAuthority?: WindowsTerminalAuthority;
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders: boolean;
  runtimeGenerationId: string;
  systemBootId: string;
  confirmedTerminatedRuntimeGenerationIds?: readonly string[];
  /** Optional trusted desktop override; never accepted from the renderer. */
  codexBinaryPath?: string;
  /** Main-owned import root used to revalidate brokered attachment capabilities. */
  attachmentRoot?: string;
  /** Safe configuration only; credential values remain in the main-process vault. */
  kimiClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
  /** Test-only packaged-runtime proof that the native PDF stack can execute. */
  packageSmokePdf?: {
    inputPath: string;
    resultPath: string;
  };
  /** Test-only packaged proof for fuse-safe durable image retention. */
  packageSmokeImage?: {
    inputPath: string;
    resultPath: string;
  };
  /** Privileged deterministic fault injection used by lifecycle tests only. */
  recoveryImportFault?: {
    phase: "after-staging-publish" | "during-message-import";
    markerPath: string;
    stallMs: number;
  };
}
