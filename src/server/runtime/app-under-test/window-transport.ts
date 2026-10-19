import type { Readable, Writable } from "node:stream";

import type {
  AppUnderTestErrorCode,
  AppUnderTestLogStream,
  AppUnderTestTransport,
  AppUnderTestWindow,
  AppUnderTestWindowAccessGate,
} from "../../../shared/app-under-test";
import type { AgentBrowserKey } from "../../../shared/agent-browser";
import type { PreviewAgentDialogKind } from "../../../shared/preview-agent-dialogs";

/**
 * Seams between the process-owning launch manager and a window transport.
 * Electron launches use a CDP client over the debugging pipe (fds 3 and 4);
 * action launches use the accessibility transport over main's App control
 * broker when one is installed. Either way the host tools see one interface.
 */

export type AppUnderTestTransportKind = AppUnderTestTransport;

/** The provider turn a window command runs for; absent for background reads. */
export interface AppUnderTestTurn {
  runId: string;
  turnId: string;
}

/** What a transport can say about why it shows no windows. */
export interface AppUnderTestTransportStatus {
  /** A permission or platform gate with its next step, or null. */
  unavailable: string | null;
  /** Apps of the launch's process tree whose windows Inertia never reads (password managers, system prompts). */
  protectedApps: number;
  /** The fixed category of `unavailable`, for the App surface; null when nothing blocks reading. */
  access: AppUnderTestWindowAccessGate | null;
}

export type AppUnderTestWindowCommand =
  | { action: "snapshot"; windowId: string }
  | { action: "screenshot"; windowId: string }
  | { action: "wait"; windowId: string; text?: string; state: "visible" | "hidden" | "loaded"; timeoutMs: number }
  | { action: "click"; windowId: string; ref: string; dialog?: "accept" }
  | { action: "type"; windowId: string; ref: string; text: string; replace: boolean; dialog?: "accept" }
  | { action: "press"; windowId: string; key: AgentBrowserKey; dialog?: "accept" }
  | { action: "scroll"; windowId: string; deltaY: number }
  | { action: "scroll"; windowId: string; ref: string };

export type AppUnderTestDestructiveWindowCommand = Extract<
  AppUnderTestWindowCommand,
  { action: "click" | "type" | "press" | "scroll" }
>;

/** What an approval card may name about a control; produced by the transport. */
export interface AppUnderTestWindowTarget {
  role: string;
  label: string;
  /** Password or credential-named control: typed text is never displayed. */
  sensitive: boolean;
}

export interface AppUnderTestWindowInspection {
  windowId: string;
  /**
   * A stable number assigned when the window first appears (1, 2, ...),
   * shown instead of the untrusted title.
   */
  windowNumber: number;
  /** Increments on every navigation of the window's main frame. */
  documentSequence: number;
  /**
   * The ref's control, or for a press the focused control; null for a
   * scroll by pixels.
   */
  target: AppUnderTestWindowTarget | null;
  /** The JavaScript dialog the window shows now, which the input answers first. */
  dialog: PreviewAgentDialogKind | null;
}

/** A JavaScript dialog left open in a window, which blocks reading it. */
export interface AppUnderTestPendingDialog {
  windowId: string;
  windowNumber: number;
  documentSequence: number;
  kind: PreviewAgentDialogKind;
}

export type AppUnderTestWindowFailureCode = Extract<
  AppUnderTestErrorCode,
  "invalid" | "not-found" | "unavailable" | "timeout" | "too-large" | "cancelled" | "sensitive"
>;

export interface AppUnderTestWindowFailure {
  ok: false;
  code: AppUnderTestWindowFailureCode;
  /** Says what to do next; already safe to show to a model. */
  message: string;
  /** True when input may already have reached the app. */
  dispatched: boolean;
  /** Set when the command was refused because the window shows a JavaScript dialog. */
  pendingDialog?: AppUnderTestPendingDialog;
}

export type AppUnderTestWindowResult =
  | { ok: true; value: Record<string, unknown> }
  | AppUnderTestWindowFailure;

export type AppUnderTestWindowInspectionResult =
  | { ok: true; inspection: AppUnderTestWindowInspection }
  | AppUnderTestWindowFailure;

export interface AppUnderTestWindowPerformOptions {
  signal: AbortSignal;
  /**
   * Present for an approved action. The transport must refuse with
   * `not-found` and `dispatched: false` unless the window still shows this
   * document and the ref still resolves to an equal target.
   */
  expected?: Pick<AppUnderTestWindowInspection, "documentSequence" | "target" | "dialog">;
  /**
   * Answer only the window's open dialog (it must still be `expected.dialog`)
   * and send nothing else: a Supervised approval whose control could not be
   * inspected while the dialog was open.
   */
  dialogOnly?: boolean;
  turn?: AppUnderTestTurn;
}

export interface AppUnderTestWindowTransport {
  /** Current page windows, at most MAX_APP_WINDOWS, already sanitized. */
  windows(): readonly AppUnderTestWindow[];
  /** The first window that shows a JavaScript dialog nobody has answered, if any. */
  pendingDialog(): AppUnderTestPendingDialog | null;
  /**
   * Hides every secret this launch's windows revealed (typed into or found in
   * sensitive fields) from one log line; `cut` marks a line cut at its bound.
   */
  redactLog(text: string, cut: boolean): string;
  /** Read-only inspection that prepares an approval; must not change the app. */
  inspect(
    command: AppUnderTestDestructiveWindowCommand,
    signal: AbortSignal,
    turn?: AppUnderTestTurn,
  ): Promise<AppUnderTestWindowInspectionResult>;
  perform(
    command: AppUnderTestWindowCommand,
    options: AppUnderTestWindowPerformOptions,
  ): Promise<AppUnderTestWindowResult>;
  /** Resolves true once the first page window exists, false on timeout or abort; `turn` is the launching turn. */
  waitForWindow(signal: AbortSignal, timeoutMs: number, turn?: AppUnderTestTurn): Promise<boolean>;
  /** Idempotent; called on stop, exit, chat clear and runtime shutdown. */
  close(): void;
  /**
   * Re-reads the window list when the transport polls it; CDP pushes changes
   * instead. `turn` is the agent turn asking; background polling has none.
   */
  refreshWindows?(signal: AbortSignal, turn?: AppUnderTestTurn): Promise<void>;
  status?(): AppUnderTestTransportStatus;
  /** Polling transports: re-checks whether anyone watches the launch, starting or stopping background reads. */
  watchChanged?(): void;
}

export type AppUnderTestEvidenceInput =
  | { kind: "action"; action: "click" | "type" | "press" | "scroll" }
  | { kind: "screenshot"; png: Uint8Array; width: number; height: number };

export interface AppUnderTestCdpTransportContext {
  launchId: string;
  conversationId: string;
  pid: number;
  /** fd 3 of the launched Electron process: Inertia writes requests here. */
  input: Writable;
  /** fd 4 of the launched Electron process: the app writes replies here. */
  output: Readable;
  /** Adds console, exception and crash lines to the launch's log ring. */
  log(stream: Extract<AppUnderTestLogStream, "console" | "exception" | "crash">, text: string): void;
  /** Adds bounded local evidence; returns its id, or null when it was refused. */
  evidence(entry: AppUnderTestEvidenceInput): string | null;
  /** Call after windows() changed so the App surface can refresh. */
  windowsChanged(): void;
}

/** An action launch's native windows, reached through main's App control broker. */
export interface AppUnderTestAccessibilityTransportContext {
  launchId: string;
  conversationId: string;
  pid: number;
  /** Epoch milliseconds just before the launch was spawned; main checks the root against it. */
  processStartedAt: number;
  evidence(entry: AppUnderTestEvidenceInput): string | null;
  /** Call after windows(), the protected count or the gate changed. */
  windowsChanged(): void;
  /**
   * True while the chat has a live renderer subscriber or an active turn;
   * background window polling runs only then. Absent means always.
   */
  watched?(): boolean;
}

export interface AccessibilityTransportFactory {
  /** Returns null when no App control broker is available. */
  create(context: AppUnderTestAccessibilityTransportContext): AppUnderTestWindowTransport | null;
}

export interface CdpTransportFactory {
  /** Returns null when no CDP client is available; the launch reports `cdp: false`. */
  create(context: AppUnderTestCdpTransportContext): AppUnderTestWindowTransport | null;
}

/**
 * Installed until the CDP client lands. It never closes fd 3: Chromium treats
 * a closed debugging pipe as a request to quit. It drains fd 4 so a reply can
 * never block the app on a full pipe.
 */
export const NO_CDP_TRANSPORT: CdpTransportFactory = Object.freeze({
  create(context: AppUnderTestCdpTransportContext): null {
    context.output.on("error", () => undefined);
    context.input.on("error", () => undefined);
    context.output.resume();
    return null;
  },
});

const NO_WINDOW_TRANSPORT_FAILURE: AppUnderTestWindowFailure = Object.freeze({
  ok: false,
  code: "unavailable",
  message: "No window transport for this launch.",
  dispatched: false,
});

/** Answers every window request of a launch that has no transport. */
export const UNAVAILABLE_WINDOW_TRANSPORT: AppUnderTestWindowTransport = Object.freeze({
  windows: () => [],
  pendingDialog: () => null,
  redactLog: (text: string) => text,
  inspect: async () => NO_WINDOW_TRANSPORT_FAILURE,
  perform: async () => NO_WINDOW_TRANSPORT_FAILURE,
  waitForWindow: async () => false,
  close: () => undefined,
});
