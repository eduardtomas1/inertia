export interface RuntimeConnection {
  websocketUrl: string;
}

export interface DesktopAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}

export interface AttachmentImport {
  name: string;
  mimeType: DesktopAttachment["mimeType"];
  data: ArrayBuffer;
}

export interface PreviewBounds { x: number; y: number; width: number; height: number }
export interface PreviewState { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }

export interface DesktopBridge {
  getRuntimeConnection: () => Promise<RuntimeConnection>;
  selectDirectory: () => Promise<string | null>;
  selectCodexExecutable: () => Promise<string | null>;
  /** Reveals Inertia's fixed local diagnostics directory; no caller-supplied path is accepted. */
  revealRuntimeLogs: () => Promise<string>;
  selectAttachments: () => Promise<DesktopAttachment[]>;
  importAttachments: (files: AttachmentImport[]) => Promise<DesktopAttachment[]>;
  openPath: (path: string) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  previewNavigate: (url: string) => Promise<PreviewState>;
  previewCommand: (action: "back" | "forward" | "reload") => Promise<PreviewState>;
  previewSetBounds: (bounds: PreviewBounds | null) => Promise<void>;
  previewClose: () => Promise<void>;
  getPlatform: () => string;
}

declare global {
  interface Window {
    inertia: DesktopBridge;
  }
}

export {};
