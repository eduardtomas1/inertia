import { isAbsolute } from "node:path";

import type { ProviderHarnessLaunchConfiguration, ProviderInstallationUseTransfer } from "./contracts";

export interface NativeConversationIdentity {
  projectId: string;
  conversationId: string;
  workspaceId: string;
  repositoryId: string | null;
  providerInstanceId: string;
}

export interface NativeConversationSource {
  identity: NativeConversationIdentity;
  nativeConversationId: string;
  /** Session-tree root; never infer this from a fork's conversation ID. */
  nativeSessionId?: string;
  /** Actual persisted head, which may be ahead of a deferred Claude cursor. */
  expectedHeadId: string | null;
}

export type NativeConversationBoundary =
  | { kind: "turn"; nativeTurnId: string }
  | { kind: "start"; inheritedHeadId?: string };

export type NativeConversationRequest = {
  operationId: string;
  source: NativeConversationSource;
  boundary: NativeConversationBoundary;
} & (
  | { kind: "fork"; targetConversationId: string }
  | { kind: "rollback" }
);

export type NativeConversationContinuation =
  | { kind: "resume-cursor"; nativeConversationId: string; resumeSessionAt: string }
  | { kind: "new-session"; nativeConversationId: string };

export interface NativeConversationLaunch {
  executable: string;
  installationVersion?: string | null;
  /** Already sanitized for the exact provider instance by the privileged caller. */
  environment: NodeJS.ProcessEnv;
  /** Already authorized canonical workspace; checked again before any work. */
  cwd: string;
  /** Canonical source workspace when a native fork targets another workspace. */
  sourceCwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  installationUse?: ProviderInstallationUseTransfer;
  harnessConfiguration?: ProviderHarnessLaunchConfiguration;
}

export interface NativeConversationBacking {
  nativeConversationId: string;
  nativeSessionId?: string;
  headId: string | null;
  /** Physical history head; a deferred rollback does not immediately change it. */
  persistedHeadId: string | null;
  continuation?: NativeConversationContinuation;
}

export type NativeConversationResult = {
  operationId: string;
  identity: NativeConversationIdentity;
  targetConversationId?: string;
} & (
  | { status: "completed"; effect: "native-fork" | "native-revert" | "resume-cursor" | "new-session" | "unchanged"; backing: NativeConversationBacking }
  | { status: "unsupported" | "rejected"; reason: string }
  | { status: "failed"; reason: "cancelled" | "deadline" | "provider-failure" | "cleanup-unconfirmed"; mutationMayHaveOccurred: boolean; createdNativeConversationId?: string }
);

/** Caller must hold the durable source mutation lock and exclude active runs. */
export interface NativeConversationOperations {
  capabilities: { fork: "native"; rollback: "native-revert" | "resume-cursor" | "native-fork" };
  execute(request: NativeConversationRequest, launch: NativeConversationLaunch): Promise<NativeConversationResult>;
}

export class NativeConversationRejection extends Error {
  constructor(readonly status: "unsupported" | "rejected", readonly reason: string) {
    super(reason);
  }
}

export function nativeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

export function validateNativeConversationRequest(request: NativeConversationRequest, launch: NativeConversationLaunch): void {
  const { identity, nativeConversationId, nativeSessionId, expectedHeadId } = request.source;
  if (!nativeId(request.operationId) || !nativeId(nativeConversationId)
    || (nativeSessionId !== undefined && !nativeId(nativeSessionId))
    || (expectedHeadId !== null && !nativeId(expectedHeadId))
    || ![identity.projectId, identity.conversationId, identity.workspaceId, identity.providerInstanceId].every(nativeId)
    || (identity.repositoryId !== null && !nativeId(identity.repositoryId))
    || !isAbsolute(launch.cwd)
    || (request.boundary.kind === "turn" && !nativeId(request.boundary.nativeTurnId))
    || (request.boundary.kind === "start" && request.boundary.inheritedHeadId !== undefined && !nativeId(request.boundary.inheritedHeadId))
    || (request.kind === "fork" && (!nativeId(request.targetConversationId) || request.targetConversationId === identity.conversationId))) {
    throw new NativeConversationRejection("rejected", "invalid-request");
  }
}

export function retainedNativeHead(boundary: NativeConversationBoundary): string | null {
  return boundary.kind === "turn" ? boundary.nativeTurnId : boundary.inheritedHeadId ?? null;
}

