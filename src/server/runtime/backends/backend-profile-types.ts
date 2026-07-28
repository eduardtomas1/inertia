import type { BackendCredentialStatus } from "../../../shared/backend-credentials";
import type { ClaudeCompatibleBackendProfile } from "../../../shared/claude-backend-profiles";
import type { RuntimeStore } from "../../database";

export interface BackendCredentialBroker {
  resolve(
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  status(
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<BackendCredentialStatus>;
  forget(
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface BackendProfileControllerOptions {
  store: RuntimeStore;
  credentials?: BackendCredentialBroker;
  builtInClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
}

export class BackendProfileControllerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendProfileControllerError";
  }
}
