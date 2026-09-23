import type { TestInfo } from "@playwright/test";
import { captureBoundedFailureDiagnostic } from "../../helpers/bounded-failure-diagnostic";

export type AnchorInputCommand = {
  action: "install" | "read" | "heartbeat" | "dispose";
  expectedValue?: string;
};

// Self-contained so Playwright can serialize it into this scenario's renderer.
export function observeAnchorInput({ action, expectedValue = "" }: AnchorInputCommand): unknown {
  const key = "__inertiaAnchorInputDiagnostic";
  type Observer = { read(): unknown; dispose(): void };
  const previous = Reflect.get(window, key) as Observer | undefined;
  if (action === "dispose") {
    previous?.dispose();
    Reflect.deleteProperty(window, key);
    return null;
  }
  if (action === "read") return previous?.read() ?? null;
  if (action === "heartbeat") return new Promise<"frame" | "no-frame">((resolve) => {
    const frame = requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve("frame");
    });
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      resolve("no-frame");
    }, 100);
  });
  previous?.dispose();
  const selector = '.composer[aria-label="Message composer"] textarea[aria-label="Message"]';
  const initial = document.querySelector<HTMLTextAreaElement>(selector);
  const boolean = (value: string | null | undefined): boolean | null =>
    value === "true" ? true : value === "false" ? false : null;
  const code = (value: string | null | undefined, allowed: readonly string[]): string | null =>
    value && allowed.includes(value) ? value : null;
  const snapshot = () => {
    const composer = document.querySelector<HTMLElement>('.composer[aria-label="Message composer"]');
    const textarea = document.querySelector<HTMLTextAreaElement>(selector);
    const send = composer?.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
    const readiness = composer?.querySelector<HTMLElement>(".provider-readiness");
    return {
      atMs: Math.round(performance.now()),
      textareaPresent: Boolean(textarea),
      initialTextareaConnected: initial?.isConnected ?? false,
      sameTextarea: Boolean(textarea && textarea === initial),
      textareaFocused: Boolean(textarea && document.activeElement === textarea),
      valueLength: textarea?.value.length ?? null,
      valueMatches: textarea ? textarea.value === expectedValue : null,
      textareaDisabled: textarea?.disabled ?? null,
      composerDisabled: boolean(composer?.dataset.disabled),
      composerBusy: boolean(composer?.getAttribute("aria-busy")),
      primaryAction: code(composer?.dataset.primaryAction,
        ["send-disabled", "send-ready", "submitting", "stop-ready", "stop-pending"]),
      sendPresent: Boolean(send),
      sendDisabled: send?.disabled ?? null,
      sendBusy: boolean(send?.getAttribute("aria-busy")),
      readinessPresent: Boolean(readiness),
      readinessTransient: boolean(readiness?.dataset.transient),
      routeRepair: code(readiness?.dataset.routeRepair,
        ["none", "install", "connect", "add-key", "configure", "probe", "refresh"]),
      connection: code(document.querySelector<HTMLElement>(".app-shell")?.dataset.connectionStatus,
        ["online", "connecting", "offline"]),
    };
  };
  const events: { type: "input" | "change"; state: ReturnType<typeof snapshot> }[] = [];
  let inputCount = 0;
  let changeCount = 0;
  const record = (event: Event): void => {
    if (!(event.target instanceof HTMLTextAreaElement) || !event.target.matches(selector)) return;
    if (event.type === "input") inputCount = Math.min(inputCount + 1, 1_000_000);
    else changeCount = Math.min(changeCount + 1, 1_000_000);
    events.push({ type: event.type === "input" ? "input" : "change", state: snapshot() });
    if (events.length > 8) events.shift();
  };
  const observer: Observer = {
    read: () => ({ state: snapshot(), inputCount, changeCount, events: [...events] }),
    dispose: () => {
      document.removeEventListener("input", record, true);
      document.removeEventListener("change", record, true);
    },
  };
  document.addEventListener("input", record, true);
  document.addEventListener("change", record, true);
  Reflect.set(window, key, observer);
  return observer.read();
}

export function createAnchorInputDiagnostic(
  evaluate: (command: AnchorInputCommand) => Promise<unknown>,
  expectedValue: string,
) {
  const capture = (action: AnchorInputCommand["action"]) => captureBoundedFailureDiagnostic(
    () => evaluate({ action, ...(action === "install" ? { expectedValue } : {}) }), 500,
  );
  let before: Awaited<ReturnType<typeof capture>> | null = null;
  let after: ReturnType<typeof capture> | null = null;
  return {
    install: async () => { before = await capture("install"); },
    // Do not await this observation between the original Fill and Click.
    afterFill: () => { after = capture("read"); },
    attach: async (testInfo: Pick<TestInfo, "attach">) => {
      const [postFill, failure, heartbeat] = await Promise.all([
        after, capture("read"), capture("heartbeat"),
      ]);
      await captureBoundedFailureDiagnostic(() => testInfo.attach("anchor-input-diagnostic", {
        contentType: "application/json",
        body: JSON.stringify({ before, postFill, failure, heartbeat }),
      }), 250);
    },
    // A stuck renderer must not hold up the fixture's privileged cleanup.
    dispose: () => { void capture("dispose"); },
  };
}
