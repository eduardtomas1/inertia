import type { ChatAttachmentMimeType } from "./attachments";
import type {
  PrivateConnectConversationGrant,
} from "./private-connect/grants";
import type {
  PrivateConnectPreset,
} from "./private-connect/scopes";
import type { PrivateConnectStateView } from "./private-connect/protocol";

export const PRIVATE_CONNECT_IPC = {
  getState: "inertia:private-connect-state",
  stateChanged: "inertia:private-connect-state-changed",
  setEnabled: "inertia:private-connect-set-enabled",
  createInvitation: "inertia:private-connect-create-invitation",
  approvePairing: "inertia:private-connect-approve-pairing",
  denyPairing: "inertia:private-connect-deny-pairing",
  revokeDevice: "inertia:private-connect-revoke-device",
  updateDevice: "inertia:private-connect-update-device",
} as const;

export interface RuntimeConnection {
  websocketUrl: string;
  databaseRecoveryNotice?: DatabaseRecoveryStartupNotice;
}

export interface DatabaseRecoveryStartupNotice {
  id: string;
  outcome: "restored" | "created-empty";
  trigger: "primary-missing" | "primary-corrupt";
  preservedCorruptPrimary: boolean;
  invalidBackupsSkipped: number;
  unsupportedBackupsSkipped: number;
}

export interface DatabaseRecoveryImportSummary {
  projects: number;
  conversations: number;
  messages: number;
  alreadyImported: boolean;
}

export type DatabaseRecoveryExportResult =
  | { status: "cancelled" }
  | { status: "exported" };

export type DatabaseRecoveryImportResult =
  | { status: "cancelled" }
  | { status: "imported"; summary: DatabaseRecoveryImportSummary };

export type AppUpdateState = "available" | "current" | "unavailable";
export type AppUpdateFreshness = "fresh" | "cached" | "unavailable";

export interface AppUpdateStatus {
  state: AppUpdateState;
  freshness: AppUpdateFreshness;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: string | null;
  lastAttemptedAt: string;
  message: string;
}

export interface DesktopAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

export interface AttachmentImport {
  name: string;
  /** Renderer-declared only; the privileged boundary verifies it against bytes and extension. */
  mimeType: string;
  data: ArrayBuffer;
}

export interface PreviewBounds { x: number; y: number; width: number; height: number }
export interface PreviewState { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
export interface PreviewStateUpdate extends PreviewState {
  ownerId: "primary" | "secondary";
  contextId: string;
}

export type ProjectPathAction = "open-externally" | "reveal";

export interface OpenProjectPathRequest {
  projectId: string;
  conversationId?: string;
  relativePath: string;
  action: ProjectPathAction;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isProjectRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || /[\0\r\n]/u.test(value)
    || /^[\\/]/u.test(value)
    || /^[A-Za-z]:/u.test(value)
  ) return false;
  return !value.split(/[\\/]/u).some((segment) => segment === "..");
}

export function parseOpenProjectPathRequest(value: unknown): OpenProjectPathRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<Record<keyof OpenProjectPathRequest, unknown>>;
  const keys = Object.keys(value);
  const hasConversationId = Object.prototype.hasOwnProperty.call(value, "conversationId");
  if (
    keys.length !== (hasConversationId ? 4 : 3)
    || !keys.every((key) => key === "projectId" || key === "conversationId" || key === "relativePath" || key === "action")
    || typeof candidate.projectId !== "string"
    || !UUID_PATTERN.test(candidate.projectId)
    || (hasConversationId && (typeof candidate.conversationId !== "string" || !UUID_PATTERN.test(candidate.conversationId)))
    || !isProjectRelativePath(candidate.relativePath)
    || (candidate.action !== "open-externally" && candidate.action !== "reveal")
  ) return null;
  return {
    projectId: candidate.projectId,
    ...(hasConversationId ? { conversationId: candidate.conversationId as string } : {}),
    relativePath: candidate.relativePath,
    action: candidate.action,
  };
}

export interface PrivateConnectEnableRequest {
  enabled: boolean;
}

export interface PrivateConnectPairingApprovalRequest {
  requestId: string;
  preset: PrivateConnectPreset;
  projectIds: string[];
  grants?: PrivateConnectConversationGrant[];
  grantDays: number;
}

export interface PrivateConnectDeviceUpdateRequest {
  deviceId: string;
  preset: PrivateConnectPreset;
  projectIds: string[];
  grants?: PrivateConnectConversationGrant[];
  expiresAt: string;
}

export function parsePrivateConnectEnableRequest(value: unknown): PrivateConnectEnableRequest | null {
  return plainObject(value)
    && Object.keys(value).length === 1
    && typeof value.enabled === "boolean"
    ? { enabled: value.enabled }
    : null;
}

export function parsePrivateConnectPairingApprovalRequest(value: unknown): PrivateConnectPairingApprovalRequest | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  const hasGrants = Object.prototype.hasOwnProperty.call(value, "grants");
  if (
    keys.length !== (hasGrants ? 5 : 4)
    || !keys.every((key) => key === "requestId" || key === "preset" || key === "projectIds" || key === "grants" || key === "grantDays")
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || (value.preset !== "monitor" && value.preset !== "collaborate")
    || !boundedEntityIds(value.projectIds, 64)
    || (hasGrants && !privateConnectGrantList(value.grants))
    || typeof value.grantDays !== "number"
    || !Number.isInteger(value.grantDays)
    || value.grantDays < 1
    || value.grantDays > 90
  ) return null;
  return {
    requestId: value.requestId,
    preset: value.preset,
    projectIds: [...new Set(value.projectIds as string[])],
    ...(hasGrants ? { grants: value.grants as PrivateConnectConversationGrant[] } : {}),
    grantDays: value.grantDays,
  };
}

export function parsePrivateConnectDeviceUpdateRequest(value: unknown): PrivateConnectDeviceUpdateRequest | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  const hasGrants = Object.prototype.hasOwnProperty.call(value, "grants");
  if (
    keys.length !== (hasGrants ? 5 : 4)
    || !keys.every((key) => key === "deviceId" || key === "preset" || key === "projectIds" || key === "grants" || key === "expiresAt")
    || typeof value.deviceId !== "string"
    || !UUID_PATTERN.test(value.deviceId)
    || (value.preset !== "monitor" && value.preset !== "collaborate")
    || !boundedEntityIds(value.projectIds, 64)
    || (hasGrants && !privateConnectGrantList(value.grants))
    || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt))
  ) return null;
  return {
    deviceId: value.deviceId,
    preset: value.preset,
    projectIds: [...new Set(value.projectIds as string[])],
    ...(hasGrants ? { grants: value.grants as PrivateConnectConversationGrant[] } : {}),
    expiresAt: value.expiresAt,
  };
}

function privateConnectGrantList(value: unknown): value is PrivateConnectConversationGrant[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  return value.every((candidate) => {
    if (!plainObject(candidate)) return false;
    const keys = Object.keys(candidate);
    return keys.length === 3
      && keys.every((key) => key === "projectId" || key === "conversationIds" || key === "includeFutureConversations")
      && boundedEntityId(candidate.projectId)
      && boundedEntityIds(candidate.conversationIds, 256)
      && typeof candidate.includeFutureConversations === "boolean";
  });
}

function boundedEntityId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200;
}

function boundedEntityIds(value: unknown, maximum: number): value is string[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  for (const candidate of value) {
    if (!boundedEntityId(candidate)) return false;
  }
  return true;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DesktopBridge {
  getRuntimeConnection: () => Promise<RuntimeConnection>;
  /** Wakes a reconnect attempt without exposing the runtime URL capability. */
  onRuntimeReady: (listener: () => void) => () => void;
  selectDirectory: () => Promise<string | null>;
  selectCodexExecutable: () => Promise<string | null>;
  /** Writes a bounded transcript-only recovery export chosen by the user. */
  exportRecoveryData: () => Promise<DatabaseRecoveryExportResult>;
  /** Imports a strictly validated recovery export under fresh local identities. */
  importRecoveryData: () => Promise<DatabaseRecoveryImportResult>;
  /** Reveals Inertia's fixed local diagnostics directory; no caller-supplied path is accepted. */
  revealRuntimeLogs: () => Promise<string>;
  /** Copies a fixed, allowlisted lifecycle summary. Prompts, source, paths, and credentials are excluded. */
  copyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
  /** Writes renderer-visible text to the system clipboard; the hardened renderer session denies direct clipboard access. */
  copyText: (text: string) => Promise<boolean>;
  /** Reads only the latest public GitHub release metadata; updates are never downloaded or installed. */
  checkAppUpdate: (force?: boolean) => Promise<AppUpdateStatus>;
  selectAttachments: () => Promise<DesktopAttachment[]>;
  importAttachments: (files: AttachmentImport[]) => Promise<DesktopAttachment[]>;
  /** Releases an unsent temporary attachment and its privileged preview registration. */
  releaseAttachment: (id: string) => Promise<void>;
  /** Opens only a revalidated opaque PDF attachment in the platform's default app. */
  openAttachmentExternally: (id: string) => Promise<void>;
  /** Internal file selection stays in the renderer; only scoped OS actions cross this bridge. */
  openProjectPath: (request: OpenProjectPathRequest) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  previewNavigate: (request: {
    ownerId: string;
    contextId: string;
    url: string;
  }) => Promise<PreviewState>;
  previewCommand: (request: {
    ownerId: string;
    contextId: string;
    action: "back" | "forward" | "reload";
  }) => Promise<PreviewState>;
  previewSetBounds: (request: {
    ownerId: string;
    contextId: string;
    bounds: PreviewBounds | null;
  }) => Promise<void>;
  previewClose: (request: {
    ownerId: string;
    contextId: string;
  }) => Promise<void>;
  /** Subscribes to navigation initiated inside an owned desktop preview. */
  onPreviewState: (listener: (state: PreviewStateUpdate) => void) => () => void;
  syncThemePreference: (preference: "system" | "light" | "dark") => Promise<void>;
  /** Writes directly to Electron's privileged credential vault; plaintext is never returned. */
  setBackendCredential: (request: SetBackendCredentialRequest) => Promise<BackendCredentialState>;
  clearBackendCredential: (request: BackendCredentialProfileRequest) => Promise<BackendCredentialState>;
  getBackendCredentialState: (request: BackendCredentialProfileRequest) => Promise<BackendCredentialState>;
  getPrivateConnectState: () => Promise<PrivateConnectStateView>;
  onPrivateConnectState: (listener: (state: PrivateConnectStateView) => void) => () => void;
  setPrivateConnectEnabled: (request: PrivateConnectEnableRequest) => Promise<PrivateConnectStateView>;
  createPrivateConnectInvitation: () => Promise<{ url: string; expiresAt: string }>;
  approvePrivateConnectPairing: (request: PrivateConnectPairingApprovalRequest) => Promise<PrivateConnectStateView>;
  denyPrivateConnectPairing: (requestId: string) => Promise<PrivateConnectStateView>;
  revokePrivateConnectDevice: (deviceId: string) => Promise<PrivateConnectStateView>;
  updatePrivateConnectDevice: (request: PrivateConnectDeviceUpdateRequest) => Promise<PrivateConnectStateView>;
  getPlatform: () => string;
}

declare global {
  interface Window {
    inertia: DesktopBridge;
  }
}
import type {
  BackendCredentialProfileRequest,
  BackendCredentialState,
  SetBackendCredentialRequest,
} from "./backend-credentials";
