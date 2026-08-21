import type { ChatAttachmentMimeType } from "./attachments";
import { MAX_CHAT_MESSAGE_CHARS } from "./diff-review";
import {
  PRIVATE_CONNECT_GRANT_LIMITS,
  type PrivateConnectConversationGrant,
} from "./private-connect/grants";
import type {
  PrivateConnectPreset,
} from "./private-connect/scopes";
import type { PrivateConnectStateView } from "./private-connect/protocol";
export { PRIVATE_CONNECT_IPC } from "./private-connect/ipc";

export interface RuntimeConnection {
  websocketUrl: string;
  databaseRecoveryNotice?: DatabaseRecoveryStartupNotice;
}

export interface RuntimeConnectionUnavailable {
  unavailable: true;
  message: string;
}

export type RuntimeConnectionResult =
  | RuntimeConnection
  | RuntimeConnectionUnavailable;

export interface DatabaseRecoveryStartupNotice {
  id: string;
  outcome: "restored" | "created-empty";
  trigger: "primary-missing" | "primary-corrupt";
  preservedCorruptPrimary: boolean;
  invalidBackupsSkipped: number;
  unsupportedBackupsSkipped: number;
}

export interface InertiaReleaseInfo {
  tag: string;
  name: string | null;
  url: string | null;
  createdAt: string;
  releasedAt: string | null;
  description: string | null;
}

export interface SendDiscordReleaseInfoRequest {
  repositoryUrl: string;
  previousRelease: InertiaReleaseInfo;
  release: InertiaReleaseInfo;
}

export interface ListInertiaReleasesRequest {
  repositoryUrl: string;
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

export type AppUpdateState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "cancelled"
  | "downloaded"
  | "installing"
  | "current"
  | "unavailable"
  | "failed";
export type AppUpdateFreshness = "fresh" | "cached" | "unavailable";
export type AppUpdateDelivery = "in-app" | "manual";
export type AppUpdateDeliveryReason =
  | "development-build"
  | "capability-missing"
  | "capability-invalid"
  | "platform-mismatch"
  | "macos-signing-unavailable"
  | "windows-signing-unavailable"
  | "appimage-unavailable"
  | "appimage-invalid"
  | "appimage-not-replaceable";
export type AppUpdateInstallBlocker =
  | "active-work"
  | "terminal"
  | "maintenance"
  | "database-recovery"
  | "local-operation"
  | "runtime-transition"
  | "private-connect"
  | "shutdown";

export interface AppUpdateProgress {
  percent: number;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
}

export interface AppUpdateStatus {
  /** Monotonic within one desktop process; rejects stale invoke responses. */
  revision: number;
  state: AppUpdateState;
  freshness: AppUpdateFreshness;
  delivery: AppUpdateDelivery;
  deliveryReason: AppUpdateDeliveryReason | null;
  installBlocker: AppUpdateInstallBlocker | null;
  progress: AppUpdateProgress | null;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  checkedAt: string | null;
  lastAttemptedAt: string | null;
  message: string;
}

export interface DesktopAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

export type AttachmentPickerMode = "all" | "images";

export function parseAttachmentPickerMode(
  value: unknown,
): AttachmentPickerMode | null {
  return value === undefined || value === "all"
    ? "all"
    : value === "images"
      ? "images"
      : null;
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

export type DesktopNotificationKind =
  | "completed"
  | "approval"
  | "input"
  | "failed";

export interface DesktopNotificationRequest {
  conversationId: string;
  kind: DesktopNotificationKind;
}

export const DETACHED_CHAT_WINDOW_LIMIT = 8;

export interface DetachedChatWindowRequest {
  conversationId: string;
  title: string;
}

export interface DetachedChatWindowOpenRequest
  extends DetachedChatWindowRequest {
  draft: string;
}

export interface DetachedChatDraftHandoff {
  conversationId: string;
  draft: string;
}

export interface PendingDetachedChatDraft extends DetachedChatDraftHandoff {
  handoffId: string;
}

export interface DetachedChatDraftAcknowledgement {
  conversationId: string;
  handoffId: string;
}

export interface DetachedChatWindowSummary {
  conversationId: string;
  alwaysOnTop: boolean;
}

export type DesktopWindowContext =
  | { role: "main" }
  | ({ role: "detached-chat"; draft: string } & DetachedChatWindowSummary);

export interface DetachedChatWindowOpenResult
  extends DetachedChatWindowSummary {
  disposition: "opened" | "focused";
}

export interface AppProcessHealth {
  pid: number;
  cpuPercent: number;
  memoryBytes: number;
}

export interface AppHealthSnapshot {
  sampledAt: string;
  totalMemoryBytes: number;
  mainProcess: AppProcessHealth | null;
  rendererProcess: AppProcessHealth | null;
  runtimeProcess: AppProcessHealth | null;
  runtimePhase: "idle" | "starting" | "ready" | "restarting" | "stopping" | "stopped";
  databaseBytes: number;
  cacheBytes: number;
  temporaryAttachmentBytes: number;
}

export function parseDesktopNotificationRequest(
  value: unknown,
): DesktopNotificationRequest | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.every((key) => key === "conversationId" || key === "kind")
    || typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || !["completed", "approval", "input", "failed"].includes(
      String(value.kind),
    )
  ) return null;
  return value as unknown as DesktopNotificationRequest;
}

export function parseDetachedChatWindowRequest(
  value: unknown,
): DetachedChatWindowRequest | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.every((key) => key === "conversationId" || key === "title")
    || typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || typeof value.title !== "string"
  ) return null;
  const title = value.title.trim();
  if (
    title.length === 0
    || title.length > 120
    || /[\0\r\n]/u.test(title)
  ) return null;
  return { conversationId: value.conversationId, title };
}

export function parseDetachedChatWindowOpenRequest(
  value: unknown,
): DetachedChatWindowOpenRequest | null {
  if (!plainObject(value) || Object.keys(value).length !== 3) return null;
  const request = parseDetachedChatWindowRequest({
    conversationId: value.conversationId,
    title: value.title,
  });
  if (
    !request
    || typeof value.draft !== "string"
    || value.draft.length > MAX_CHAT_MESSAGE_CHARS
  ) return null;
  return { ...request, draft: value.draft };
}

export function parseDetachedChatDraftHandoff(
  value: unknown,
): DetachedChatDraftHandoff | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 2
    || typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || typeof value.draft !== "string"
    || value.draft.length > MAX_CHAT_MESSAGE_CHARS
  ) return null;
  return {
    conversationId: value.conversationId,
    draft: value.draft,
  };
}

export function parsePendingDetachedChatDraft(
  value: unknown,
): PendingDetachedChatDraft | null {
  if (!plainObject(value) || Object.keys(value).length !== 3) return null;
  const handoff = parseDetachedChatDraftHandoff({
    conversationId: value.conversationId,
    draft: value.draft,
  });
  if (
    !handoff
    || typeof value.handoffId !== "string"
    || !UUID_PATTERN.test(value.handoffId)
  ) return null;
  return { ...handoff, handoffId: value.handoffId };
}

export function parseDetachedChatDraftAcknowledgement(
  value: unknown,
): DetachedChatDraftAcknowledgement | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 2
    || typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || typeof value.handoffId !== "string"
    || !UUID_PATTERN.test(value.handoffId)
  ) return null;
  return {
    conversationId: value.conversationId,
    handoffId: value.handoffId,
  };
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
      && boundedEntityIds(
        candidate.conversationIds,
        PRIVATE_CONNECT_GRANT_LIMITS.conversationsPerProject,
      )
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
  /** Identifies the main workbench or one main-owned fixed-chat renderer. */
  getWindowContext: () => Promise<DesktopWindowContext>;
  /** Opens one native, fixed-conversation chat window or focuses its existing owner. */
  openDetachedChat: (
    request: DetachedChatWindowOpenRequest,
  ) => Promise<DetachedChatWindowOpenResult>;
  focusDetachedChat: (conversationId: string) => Promise<boolean>;
  getDetachedChatWindows: () => Promise<DetachedChatWindowSummary[]>;
  onDetachedChatWindowsChanged: (
    listener: (windows: DetachedChatWindowSummary[]) => void,
  ) => () => void;
  /** Receives only the draft returned by its conversation-bound popup. */
  onDetachedChatDraftChanged: (
    listener: (handoff: PendingDetachedChatDraft) => void,
  ) => () => void;
  /** Mirrors active popup text into the persistent workbench draft owner. */
  onDetachedChatDraftMirrored: (
    listener: (handoff: DetachedChatDraftHandoff) => void,
  ) => () => void;
  /** Hydrates draft handoffs missed while the workbench renderer was unavailable. */
  getPendingDetachedChatDrafts: () => Promise<PendingDetachedChatDraft[]>;
  /** Removes only the exact pending handoff already written by the workbench. */
  acknowledgeDetachedChatDraft: (
    acknowledgement: DetachedChatDraftAcknowledgement,
  ) => Promise<boolean>;
  /** Detached-renderer-only controls; the main process validates sender ownership. */
  setDetachedChatAlwaysOnTop: (
    alwaysOnTop: boolean,
  ) => Promise<DetachedChatWindowSummary>;
  retargetDetachedChat: (
    request: DetachedChatWindowRequest,
  ) => Promise<DetachedChatWindowSummary>;
  /** Explicitly returns the chat to the main workbench. Native close never docks it. */
  dockDetachedChat: (draft: string) => Promise<void>;
  closeDetachedChat: (draft: string) => Promise<void>;
  /** Synchronously preserves the owned draft during native window teardown. */
  persistDetachedChatDraft: (draft: string) => boolean;
  /** Mirrors coalesced popup edits without performing a durable handoff. */
  mirrorDetachedChatDraft: (draft: string) => boolean;
  getRuntimeConnection: () => Promise<RuntimeConnectionResult>;
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
  /** Checks the fixed release channel; unsupported packages remain manual-only. */
  checkAppUpdate: (force?: boolean) => Promise<AppUpdateStatus>;
  /** Downloads only an update already selected by the privileged updater service. */
  downloadAppUpdate: () => Promise<AppUpdateStatus>;
  cancelAppUpdateDownload: () => Promise<AppUpdateStatus>;
  /** Requests a guarded runtime shutdown and installs only after cleanup is confirmed. */
  installAppUpdate: () => Promise<AppUpdateStatus>;
  /** Receives sanitized authoritative updater snapshots. */
  onAppUpdateStatus: (listener: (status: AppUpdateStatus) => void) => () => void;
  /** Lists public Inertia module releases ordered by creation date. */
  listInertiaReleases: (
    request: ListInertiaReleasesRequest,
  ) => Promise<InertiaReleaseInfo[]>;
  /** Sends one selected release announcement through a Discord incoming webhook. */
  sendDiscordReleaseInfo: (
    request: SendDiscordReleaseInfoRequest,
  ) => Promise<{ sent: true }>;
  selectAttachments: (
    mode?: AttachmentPickerMode,
  ) => Promise<DesktopAttachment[]>;
  importAttachments: (files: AttachmentImport[]) => Promise<DesktopAttachment[]>;
  /** Pins one exact send request across the renderer/runtime IPC handoff. */
  prepareAttachmentHandoff: (request: {
    requestId: string;
    attachmentIds: string[];
  }) => Promise<void>;
  /** Drops an unused handoff without deleting attachments retained for retry. */
  finishAttachmentHandoff: (requestId: string) => Promise<void>;
  /** Releases an unsent temporary attachment and its privileged preview registration. */
  releaseAttachment: (id: string) => Promise<void>;
  /** Opens only a revalidated opaque PDF attachment in the platform's default app. */
  openAttachmentExternally: (id: string) => Promise<void>;
  /** Internal file selection stays in the renderer; only scoped OS actions cross this bridge. */
  openProjectPath: (request: OpenProjectPathRequest) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  /** Shows a generic privacy-safe notification; prompt and output text are never accepted. */
  showThreadNotification: (request: DesktopNotificationRequest) => Promise<boolean>;
  onThreadNotificationActivated: (listener: (conversationId: string) => void) => () => void;
  /** Samples aggregate local app resource use and fixed Inertia-owned storage paths. */
  getAppHealth: () => Promise<AppHealthSnapshot>;
  /** Clears Chromium's recreatable HTTP cache only; user data and provider state are untouched. */
  clearAppCache: () => Promise<AppHealthSnapshot>;
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
