import {
  MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS,
  MAX_PREVIEW_AGENT_DIALOGS,
  type PreviewAgentDialog,
} from "../../../shared/preview-agent-dialogs";
import type { CdpPipeClient } from "./cdp-pipe-client";
import {
  boundedDialogReport,
  delay,
  dialogPendingMessage,
  MESSAGES,
  Refusal,
  refusal,
  type OpenDialog,
  type Scope,
  type WindowState,
} from "./cdp-window-support";
import { appRedactDialogsExpression } from "./snapshot-script";

/** What the dialog handling needs from the window transport. */
export interface AppWindowDialogHost {
  readonly client: CdpPipeClient;
  readonly phaseTimeoutMs: number;
  closed(): boolean;
  remaining(scope: Scope): number;
  /** Evaluates one of Inertia's expressions in the window's isolated world. */
  evaluate(scope: Scope, expression: string): Promise<unknown>;
  redactText(window: WindowState, value: string, maximum: number): string;
}

/**
 * JavaScript dialogs of the App windows. A dialog blocks its renderer, so
 * read-only commands never answer one and fail fast instead; an input answers
 * the open dialog as its `dialog` argument says before it sends anything.
 * Every answer is awaited, retried once, and the dialog stays recorded as open
 * until the app acknowledges it.
 */
export class AppWindowDialogs {
  constructor(private readonly host: AppWindowDialogHost) {}

  /** The read-only refusal for a window that shows `dialog`; names its kind, never its text. */
  refusal(window: WindowState, dialog: OpenDialog): Refusal {
    return new Refusal({
      ok: false,
      code: "unavailable",
      message: dialogPendingMessage(window.windowNumber, dialog.kind),
      dispatched: false,
      pendingDialog: {
        windowId: window.windowId,
        windowNumber: window.windowNumber,
        documentSequence: window.documentSequence,
        kind: dialog.kind,
      },
    });
  }

  onDialog(
    window: WindowState,
    params: Record<string, unknown>,
    active: { scope: Scope; abort(reason: "dialog"): void } | null,
  ): void {
    const kind = params.type;
    if (kind !== "alert" && kind !== "confirm" && kind !== "prompt" && kind !== "beforeunload") return;
    const raw = typeof params.message === "string" ? params.message : "";
    const dialog: OpenDialog = {
      kind,
      message: kind === "beforeunload" ? "" : raw.slice(0, MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS),
      truncated: raw.length > MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS,
    };
    window.openDialog = dialog;
    const scope = active?.scope ?? null;
    if (scope?.kind === "input") {
      // Raised by the agent's own input: a confirm is accepted only when this
      // action asked for it, once; beforeunload lets the input's navigation go.
      let accept: boolean;
      if (kind === "confirm") {
        accept = scope.armedAccept;
        scope.armedAccept = false;
      } else {
        accept = kind === "alert" || kind === "beforeunload";
      }
      this.track(window, this.answer(window, dialog, accept));
      return;
    }
    if (params.hasBrowserHandler !== true) {
      // No app UI can ever answer this dialog, and it blocks the window.
      this.track(window, this.answer(window, dialog, kind === "alert"));
      return;
    }
    // The app's own dialog stays open for the user or the agent's next input.
    // A read-only command cannot read the blocked window, so it stops now.
    active?.abort("dialog");
  }

  /** The input's own answer to a dialog that was open before it started. */
  async answerOpen(scope: Scope, dialog: OpenDialog, accept: boolean): Promise<void> {
    scope.acceptSpent = accept;
    if (!await this.answer(scope.window, dialog, accept, scope.signal)) {
      if (scope.signal.aborted) throw refusal("cancelled", "The App action was cancelled.");
      if (scope.window.openDialog !== dialog) throw refusal("not-found", MESSAGES.changed);
      throw refusal("unavailable", "Inertia could not answer the app's open dialog, so nothing was sent. Try again, or ask the user to answer it in the app.");
    }
    scope.dialogAnswered = true;
    await delay(50, scope.signal);
  }

  /** Reports answered dialogs once, redacted and bounded like the Browser's report. */
  async detail(scope: Scope): Promise<Record<string, unknown>> {
    const { window } = scope;
    // Answers sent during this command are reported once they were acknowledged.
    if (window.answering) await Promise.race([window.answering, delay(this.host.remaining(scope), scope.signal)]);
    if (window.dialogs.length === 0 && window.dialogsOmitted === 0) return {};
    const taken = window.dialogs.splice(0, window.dialogs.length);
    const omitted = window.dialogsOmitted;
    window.dialogsOmitted = 0;
    let withheld = false;
    let messages: string[];
    const current = taken.every((entry) => entry.documentSequence === window.documentSequence)
      && window.world?.documentSequence === window.documentSequence;
    try {
      const redacted = current && taken.some((entry) => entry.message !== "")
        ? await this.host.evaluate(scope, appRedactDialogsExpression(taken))
        : taken.map((entry) => (entry.message === "" ? "" : null));
      messages = Array.isArray(redacted) && redacted.length === taken.length
        ? redacted.map((entry) => (typeof entry === "string" ? entry.slice(0, MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS) : ""))
        : taken.map(() => "");
      withheld = !current && taken.some((entry) => entry.message !== "");
    } catch {
      messages = taken.map(() => "");
      withheld = taken.some((entry) => entry.message !== "");
    }
    const dialogs: PreviewAgentDialog[] = taken.map((entry, index) => ({
      kind: entry.kind,
      message: this.host.redactText(window, messages[index] ?? "", MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS),
      answer: entry.answer,
    }));
    return boundedDialogReport(dialogs, omitted, withheld);
  }

  private track(window: WindowState, answer: Promise<boolean>): void {
    const previous = window.answering ?? Promise.resolve();
    const settled = Promise.all([previous, answer]).then(() => undefined);
    window.answering = settled;
    void settled.then(() => {
      if (window.answering === settled) window.answering = null;
    });
  }

  /** Answers one dialog; it is reported and cleared only once the app acknowledged it. */
  private async answer(window: WindowState, dialog: OpenDialog, accept: boolean, signal?: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.host.closed() || window.sessionId === null || window.openDialog !== dialog || signal?.aborted) return false;
      try {
        await this.host.client.send("Page.handleJavaScriptDialog", { accept }, {
          sessionId: window.sessionId,
          timeoutMs: this.host.phaseTimeoutMs,
          ...(signal ? { signal } : {}),
        });
      } catch {
        continue;
      }
      if (window.openDialog === dialog) window.openDialog = null;
      if (window.dialogs.length >= MAX_PREVIEW_AGENT_DIALOGS) window.dialogsOmitted += 1;
      else window.dialogs.push({ ...dialog, answer: accept ? "accept" : "dismiss", documentSequence: window.documentSequence });
      return true;
    }
    return false;
  }
}
