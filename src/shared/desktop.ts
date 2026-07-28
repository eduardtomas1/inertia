import type { ChatAttachmentMimeType } from "./attachments";

export interface RuntimeConnection {
  websocketUrl: string;
}

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

export interface DesktopBridge {
  getRuntimeConnection: () => Promise<RuntimeConnection>;
  selectDirectory: () => Promise<string | null>;
  selectCodexExecutable: () => Promise<string | null>;
  /** Reveals Inertia's fixed local diagnostics directory; no caller-supplied path is accepted. */
  revealRuntimeLogs: () => Promise<string>;
  /** Copies a fixed, allowlisted lifecycle summary. Prompts, source, paths, and credentials are excluded. */
  copyRuntimeDiagnosticReport: () => Promise<{ copied: boolean; eventCount: number }>;
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
