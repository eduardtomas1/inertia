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
  omitted: number;
  acceptNext: boolean;
}

export function installPreviewAgentDialogPolicy(
  eventName: string,
  answerEventName: string,
  maximumMessageChars: number,
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
  let acceptNext = false;
  const record = (kind: string, message: unknown): void => {
    let text = "";
    try {
      text = message === undefined ? "" : toText(message);
    } catch {
      text = "";
    }
    const detail = stringify([kind, apply(slice, text, [0, maximumMessageChars]), text.length > maximumMessageChars]);
    dispatch(new CustomEventConstructor(eventName, { __proto__: null, detail } as unknown as CustomEventInit));
  };
  listen(answerEventName, (event: Event) => {
    acceptNext = (event as CustomEvent<unknown>).detail === "accept";
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
    record("alert", message);
    return undefined;
  });
  replace("confirm", (message?: unknown): boolean => {
    const answer = acceptNext;
    acceptNext = false;
    record("confirm", message);
    return answer;
  });
  replace("prompt", (message?: unknown): null => {
    record("prompt", message);
    return null;
  });
}

export function installPreviewAgentDialogRecorder(
  eventName: string,
  maximumMessageChars: number,
  maximumDialogs: number,
): void {
  const owner = globalThis as typeof globalThis & { __inertiaAgentDialogs?: DialogRecorderState };
  if (owner.__inertiaAgentDialogs) return;
  const state: DialogRecorderState = { records: [], omitted: 0, acceptNext: false };
  owner.__inertiaAgentDialogs = state;
  owner.addEventListener(eventName, (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string" || detail.length > maximumMessageChars * 6 + 64) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(detail);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length !== 3) return;
    const [kind, message, truncated] = parsed as unknown[];
    if ((kind !== "alert" && kind !== "confirm" && kind !== "prompt")
      || typeof message !== "string" || message.length > maximumMessageChars
      || typeof truncated !== "boolean") return;
    let answer: PreviewAgentDialogAnswer = kind === "alert" ? "accept" : "dismiss";
    if (kind === "confirm") {
      answer = state.acceptNext ? "accept" : "dismiss";
      state.acceptNext = false;
    }
    if (state.records.length >= maximumDialogs) {
      state.omitted += 1;
      return;
    }
    state.records.push({ kind, message, answer, truncated });
  }, true);
}

export function armPreviewAgentDialogAnswer(answerEventName: string, answer: string): boolean {
  const owner = globalThis as typeof globalThis & { __inertiaAgentDialogs?: DialogRecorderState };
  const state = owner.__inertiaAgentDialogs;
  if (state) state.acceptNext = answer === "accept";
  owner.dispatchEvent(new CustomEvent(answerEventName, { detail: answer }));
  return true;
}

export function takePreviewAgentDialogRecords(maximumDialogs: number): {
  records: Array<PreviewAgentDialog & { truncated: boolean }>;
  omitted: number;
} {
  const state = (globalThis as typeof globalThis & { __inertiaAgentDialogs?: DialogRecorderState })
    .__inertiaAgentDialogs;
  if (!state || !Array.isArray(state.records)) return { records: [], omitted: 0 };
  const records = state.records.splice(0, maximumDialogs);
  const omitted = state.omitted + state.records.length;
  state.records.length = 0;
  state.omitted = 0;
  return { records, omitted };
}
