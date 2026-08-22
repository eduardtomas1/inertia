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
  const dispatch = EventTarget.prototype.dispatchEvent;
  const EventConstructor = Event;
  const signal = (): void => {
    dispatch.call(document, new EventConstructor(eventName));
  };
  const shadowDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  const attachShadow = shadowDescriptor?.value as Element["attachShadow"] | undefined;
  if (shadowDescriptor && typeof attachShadow === "function") {
    Object.defineProperty(Element.prototype, "attachShadow", {
      ...shadowDescriptor,
      value(this: Element, init: ShadowRootInit): ShadowRoot {
        signal();
        return Reflect.apply(attachShadow, this, [init]) as ShadowRoot;
      },
    });
  }
  const internalsDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "attachInternals",
  );
  const attachInternals = internalsDescriptor?.value as HTMLElement["attachInternals"] | undefined;
  if (internalsDescriptor && typeof attachInternals === "function") {
    Object.defineProperty(HTMLElement.prototype, "attachInternals", {
      ...internalsDescriptor,
      value(this: HTMLElement): ElementInternals {
        const internals = Reflect.apply(attachInternals, this, []) as ElementInternals;
        if (internals.shadowRoot) signal();
        return internals;
      },
    });
  }
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
  const maximumScanNodes = 4_000;
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
    const iterator = typeof document.createNodeIterator === "function"
      ? document.createNodeIterator(element, 1)
      : null;
    if (!iterator) {
      state.nestedContentObserved = true;
      return;
    }
    let scanned = 0;
    while (scanned < maximumScanNodes) {
      const descendant = iterator.nextNode() as Element | null;
      if (!descendant) return;
      scanned += 1;
      if (descendant.matches?.("iframe,frame") || descendant.shadowRoot) {
        state.nestedContentObserved = true;
      }
      const input = inputElement(descendant);
      if (input) inspect(input);
    }
    if (iterator.nextNode()) state.nestedContentObserved = true;
  };
  document.addEventListener(nestedBoundaryEvent, () => {
    state.nestedContentObserved = true;
  }, true);
  if (document.documentElement) inspectTree(document.documentElement);
  const inspectInputEvent = (event: Event): void => {
    let exposedControl = false;
    for (const node of event.composedPath()) {
      const input = inputElement(node);
      if (input) {
        exposedControl = true;
        inspect(input);
        continue;
      }
      const candidate = node as Partial<HTMLElement> | null;
      if (["TEXTAREA", "SELECT"].includes(candidate?.tagName ?? "")
        || candidate?.isContentEditable === true) exposedControl = true;
    }
    // Closed declarative roots hide their controls from an outside composed
    // path. Retain a lifetime taint before an author handler can mirror the
    // newly entered value into the ordinary top-level DOM and remove the host.
    if (!exposedControl) state.nestedContentObserved = true;
  };
  document.addEventListener("beforeinput", inspectInputEvent, true);
  document.addEventListener("input", inspectInputEvent, true);
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
