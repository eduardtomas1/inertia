interface AgentBrowserPrivacyState {
  refs: Map<string, Element>;
  nodes: WeakMap<Element, string>;
  passwordNodes: WeakSet<HTMLInputElement>;
  passwordValues: Set<string>;
  next: number;
  privacyGuardInstalled?: boolean;
  privacyObserver?: MutationObserver;
  agentInputActive?: boolean;
  nestedContentObserved?: boolean;
}

type AgentBrowserPrivacyGlobal = typeof globalThis & {
  __inertiaAgentBrowser?: AgentBrowserPrivacyState;
};

export const PREVIEW_AGENT_NESTED_BOUNDARY_EVENT = "__inertia_agent_nested_boundary__";

/** Runs in the page's main world before author scripts. */
export function installPreviewAgentShadowBoundarySignal(eventName: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  const attachShadow = descriptor?.value as Element["attachShadow"] | undefined;
  if (!descriptor || typeof attachShadow !== "function") return;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const EventConstructor = Event;
  Object.defineProperty(Element.prototype, "attachShadow", {
    ...descriptor,
    value(this: Element, init: ShadowRootInit): ShadowRoot {
      dispatch.call(document, new EventConstructor(eventName));
      return Reflect.apply(attachShadow, this, [init]) as ShadowRoot;
    },
  });
}

/**
 * Runs from the Browser preload before page scripts. Keep this function
 * self-contained because the main process also serializes it as a defensive
 * repair for already-created test documents.
 */
export function installPreviewAgentPrivacyGuard(): void {
  const owner = globalThis as AgentBrowserPrivacyGlobal;
  const nestedBoundaryEvent = "__inertia_agent_nested_boundary__";
  let state = owner.__inertiaAgentBrowser;
  if (!state) {
    state = {
      refs: new Map(),
      nodes: new WeakMap(),
      passwordNodes: new WeakSet(),
      passwordValues: new Set(),
      next: 1,
    };
    owner.__inertiaAgentBrowser = state;
  }
  if (state.privacyGuardInstalled) return;
  const maximumRememberedValues = 32;
  const normalize = (value: unknown): string => String(value ?? "")
    .replace(/\s+/gu, " ").trim();
  const remember = (value: unknown): void => {
    const normalized = normalize(value);
    if (!normalized) return;
    state.passwordValues.delete(normalized);
    state.passwordValues.add(normalized);
    while (state.passwordValues.size > maximumRememberedValues) {
      const oldest = state.passwordValues.values().next().value as string | undefined;
      if (oldest === undefined) break;
      state.passwordValues.delete(oldest);
    }
  };
  const inspect = (input: HTMLInputElement, wasPassword = false): void => {
    const value = normalize(input.value);
    if (wasPassword
      || String(input.type || "").toLowerCase() === "password"
      || state.passwordNodes.has(input)
      || (value && state.passwordValues.has(value))) {
      state.passwordNodes.add(input);
      remember(value);
    }
  };
  const inputElement = (node: unknown): HTMLInputElement | null => {
    const candidate = node as Partial<HTMLInputElement> | null;
    return candidate?.tagName === "INPUT" ? candidate as HTMLInputElement : null;
  };
  const inspectTree = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches?.("iframe,frame") || element.querySelector?.("iframe,frame")) {
      state.nestedContentObserved = true;
    }
    const directInput = inputElement(element);
    if (directInput) inspect(directInput);
    for (const input of element.querySelectorAll("input")) inspect(input);
  };
  document.addEventListener(nestedBoundaryEvent, () => {
    state.nestedContentObserved = true;
  }, true);
  if (document.querySelector?.("iframe,frame")) state.nestedContentObserved = true;
  for (const input of document.querySelectorAll("input")) inspect(input);
  document.addEventListener("input", (event) => {
    for (const node of event.composedPath()) {
      const input = inputElement(node);
      if (input) inspect(input);
    }
  }, true);
  document.addEventListener("click", (event) => {
    if (!state.agentInputActive) return;
    const fileInput = event.composedPath().some((node) => {
      const input = inputElement(node);
      return input?.type.toLowerCase() === "file";
    });
    if (!fileInput) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const changedInput = inputElement(record.target);
      if (record.type === "attributes" && changedInput) {
        inspect(changedInput, String(record.oldValue || "").toLowerCase() === "password");
      }
      for (const node of record.removedNodes) inspectTree(node);
      for (const node of record.addedNodes) inspectTree(node);
    }
  });
  observer.observe(document, {
    attributes: true,
    attributeFilter: ["type"],
    attributeOldValue: true,
    childList: true,
    subtree: true,
  });
  state.privacyGuardInstalled = true;
  state.privacyObserver = observer;
}
