export const PREVIEW_AGENT_DIALOG_EVENT = "__inertia_agent_dialog__";
export const PREVIEW_AGENT_DIALOG_ANSWER_EVENT = "__inertia_agent_dialog_answer__";
export const MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS = 1_024;
export const MAX_PREVIEW_AGENT_DIALOGS = 20;

export type PreviewAgentDialogKind = "alert" | "beforeunload" | "confirm" | "prompt";
export type PreviewAgentDialogAnswer = "accept" | "dismiss";

export interface PreviewAgentDialog {
  kind: PreviewAgentDialogKind;
  message: string;
  answer: PreviewAgentDialogAnswer;
}

interface DialogRecorderState {
  records: Array<PreviewAgentDialog & { truncated: boolean }>;
  total: number;
}

/**
 * Runs in the page's main world before author scripts. It replaces the
 * blocking dialogs with built-ins captured at document start, records each
 * call through a DOM event, and answers from the policy armed for the current
 * agent action. Keep it self-contained: it is serialized into the page.
 */
export function installPreviewAgentDialogPolicy(
  eventName: string,
  answerEventName: string,
  maximumMessageChars: number,
  maximumDialogs: number,
): void {
  const owner = globalThis as typeof globalThis & Record<string, unknown>;
  const dispatch = owner.dispatchEvent.bind(owner);
  const listen = owner.addEventListener.bind(owner);
  const CustomEventConstructor = CustomEvent;
  const stringify = JSON.stringify;
  const toText = String;
  const slice = String.prototype.slice;
  const apply = Reflect.apply;
  const describe = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  let acceptConfirm = false;
  let recorded = 0;
  const record = (kind: string, message: unknown, answer: string): void => {
    if (recorded >= maximumDialogs) return;
    recorded += 1;
    let text = "";
    try {
      text = message === undefined ? "" : toText(message);
    } catch {
      text = "";
    }
    const detail = stringify([kind, apply(slice, text, [0, maximumMessageChars]), answer, text.length > maximumMessageChars]);
    dispatch(new CustomEventConstructor(eventName, { __proto__: null, detail } as unknown as CustomEventInit));
  };
  listen(answerEventName, (event: Event) => {
    acceptConfirm = (event as CustomEvent<unknown>).detail === "accept";
  }, true);
  const replace = (name: string, value: (message?: unknown) => unknown): void => {
    const descriptor = describe(owner, name);
    define(owner, name, {
      __proto__: null,
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      writable: descriptor?.writable ?? true,
      value,
    } as PropertyDescriptor);
  };
  replace("alert", (message?: unknown): undefined => {
    record("alert", message, "accept");
    return undefined;
  });
  replace("confirm", (message?: unknown): boolean => {
    const answer = acceptConfirm;
    record("confirm", message, answer ? "accept" : "dismiss");
    return answer;
  });
  replace("prompt", (message?: unknown): null => {
    record("prompt", message, "dismiss");
    return null;
  });
}

/** Runs in the isolated Browser world and keeps a bounded per-document record. */
export function installPreviewAgentDialogRecorder(
  eventName: string,
  maximumMessageChars: number,
  maximumDialogs: number,
): void {
  const owner = globalThis as typeof globalThis & { __inertiaAgentDialogs?: DialogRecorderState };
  if (owner.__inertiaAgentDialogs) return;
  const state: DialogRecorderState = { records: [], total: 0 };
  owner.__inertiaAgentDialogs = state;
  owner.addEventListener(eventName, (event: Event) => {
    if (state.total >= maximumDialogs) return;
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string" || detail.length > maximumMessageChars * 6 + 64) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(detail);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length !== 4) return;
    const [kind, message, answer, truncated] = parsed as unknown[];
    if ((kind !== "alert" && kind !== "confirm" && kind !== "prompt")
      || typeof message !== "string" || message.length > maximumMessageChars
      || (answer !== "accept" && answer !== "dismiss") || typeof truncated !== "boolean") return;
    state.total += 1;
    state.records.push({ kind, message, answer, truncated });
  }, true);
}
