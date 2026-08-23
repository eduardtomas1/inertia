interface AgentBrowserPrivacyState {
  refs: Map<string, Element>;
  nodes: WeakMap<Element, string>;
  passwordNodes: WeakSet<HTMLInputElement>;
  passwordValues: Set<string>;
  next: number;
  privacyGuardInstalled?: boolean;
  privacyObserver?: MutationObserver;
  agentInputActive?: boolean;
  agentActivationKey?: "Enter" | "Space";
  blockedAgentActivationKey?: "Enter" | "Space";
  expectedAgentClickRef?: string;
  agentInputRefused?: "disabled" | "file" | "nested" | "retargeted";
  nestedContentObserved?: boolean;
}

type AgentBrowserPrivacyGlobal = typeof globalThis & {
  __inertiaAgentBrowser?: AgentBrowserPrivacyState;
};

export const PREVIEW_AGENT_NESTED_BOUNDARY_EVENT = "__inertia_agent_nested_boundary__";
export const PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL = "inertia:preview-agent-input-refusal";
export type PreviewAgentInputRefusal = "disabled" | "file" | "nested" | "retargeted";

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
  const maximumParserSourceCharacters = 4_096;
  const createElement = typeof Document === "undefined"
    ? undefined
    : Document.prototype.createElement;
  const getImplementation = typeof Document === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Document.prototype, "implementation")?.get;
  const createHTMLDocument = typeof DOMImplementation === "undefined"
    ? undefined
    : DOMImplementation.prototype.createHTMLDocument;
  const parseSafeHTML = Object.getOwnPropertyDescriptor(Element.prototype, "setHTML")?.value as
    | ((input: string, options?: unknown) => void)
    | undefined;
  const templateContent = typeof HTMLTemplateElement === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, "content")?.get;
  const querySelector = typeof DocumentFragment === "undefined"
    ? undefined
    : DocumentFragment.prototype.querySelector;
  const mayCreateDeclarativeRoot = (value: unknown): boolean => {
    if (typeof value !== "string" || value.length > maximumParserSourceCharacters) return true;
    if (typeof createElement !== "function" || typeof getImplementation !== "function"
      || typeof createHTMLDocument !== "function" || typeof parseSafeHTML !== "function"
      || typeof templateContent !== "function" || typeof querySelector !== "function") return true;
    try {
      // Parse in a fresh in-memory document with no browsing context or page
      // CSP. Its Trusted Types state cannot invoke a page-owned default policy,
      // while Chromium's tokenizer still decides exact start-tag attributes.
      const implementation = Reflect.apply(getImplementation, document, []) as DOMImplementation;
      const isolatedDocument = Reflect.apply(createHTMLDocument, implementation, [""]) as Document;
      const template = Reflect.apply(
        createElement,
        isolatedDocument,
        ["template"],
      ) as HTMLTemplateElement;
      Reflect.apply(parseSafeHTML, template, [value, {
        sanitizer: {
          elements: [{ name: "template", attributes: ["shadowrootmode"] }],
        },
      }]);
      const content = Reflect.apply(templateContent, template, []) as DocumentFragment;
      return Reflect.apply(querySelector, content, ["template[shadowrootmode]"]) !== null;
    } catch {
      return true;
    }
  };
  const signalDeclarativeParser = (prototype: object, name: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const parser = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
    if (!descriptor || typeof parser !== "function") return;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]): unknown {
        // These APIs can create a closed declarative root entirely while its
        // host is detached. Signal before author callbacks can mirror private
        // content and remove the host from the observable document tree. Keep
        // ordinary parser use available, but fail closed when bounded source
        // inspection cannot prove that declarative-root syntax is absent.
        if (mayCreateDeclarativeRoot(args[0])) signal();
        return Reflect.apply(parser, this, args);
      },
    });
  };
  signalDeclarativeParser(Element.prototype, "setHTML");
  signalDeclarativeParser(Element.prototype, "setHTMLUnsafe");
  if (typeof Document !== "undefined") {
    signalDeclarativeParser(Document, "parseHTML");
    signalDeclarativeParser(Document, "parseHTMLUnsafe");
  }
  if (typeof ShadowRoot !== "undefined") {
    signalDeclarativeParser(ShadowRoot.prototype, "setHTML");
    signalDeclarativeParser(ShadowRoot.prototype, "setHTMLUnsafe");
  }
}

/**
 * Runs from the Browser preload before page scripts. Keep this function
 * self-contained because the main process also serializes it as a defensive
 * repair for already-created test documents.
 */
export function installPreviewAgentPrivacyGuard(
  reportRefusal?: (refusal: PreviewAgentInputRefusal) => void,
): void {
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
  const maximumValueSourceCharacters = 4_096;
  const normalize = (value: unknown): string => String(value ?? "")
    .slice(0, maximumValueSourceCharacters)
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
    const knownPassword = wasPassword
      || String(input.type || "").toLowerCase() === "password"
      || state.passwordNodes.has(input);
    if (!knownPassword && state.passwordValues.size === 0) return;
    const value = normalize(input.value);
    if (knownPassword || (value && state.passwordValues.has(value))) {
      state.passwordNodes.add(input);
      remember(value);
    }
  };
  const inputElement = (node: unknown): HTMLInputElement | null => {
    const candidate = node as Partial<HTMLInputElement> | null;
    return candidate?.tagName === "INPUT" ? candidate as HTMLInputElement : null;
  };
  interface ScanBudget { exhausted: boolean; remaining: number }
  const scanBudget = (): ScanBudget => ({ exhausted: false, remaining: maximumScanNodes });
  const consume = (budget: ScanBudget): boolean => {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      state.nestedContentObserved = true;
      return false;
    }
    budget.remaining -= 1;
    return true;
  };
  const inspectTree = (node: Node, budget: ScanBudget): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const iterator = typeof document.createNodeIterator === "function"
      ? document.createNodeIterator(element, 1)
      : null;
    if (!iterator) {
      budget.exhausted = true;
      state.nestedContentObserved = true;
      return;
    }
    while (true) {
      const descendant = iterator.nextNode() as Element | null;
      if (!descendant) return;
      if (!consume(budget)) return;
      // A declarative shadow template is consumed by the HTML parser before
      // ordinary page code can query it. Mutation records retain the added
      // template node, so the document-start observer can taint the document
      // without enumerating or serializing the closed subtree.
      if (descendant.matches?.("iframe,frame,template[shadowrootmode]")
        || descendant.shadowRoot) {
        state.nestedContentObserved = true;
      }
      const input = inputElement(descendant);
      if (input) inspect(input);
    }
  };
  document.addEventListener(nestedBoundaryEvent, () => {
    state.nestedContentObserved = true;
  }, true);
  if (document.documentElement) inspectTree(document.documentElement, scanBudget());
  const inspectInputEvent = (event: Event): void => {
    let exposedControl = false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
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
  // Preload installs this before author scripts. Observe from the earliest
  // capture boundary so a page-owned window handler cannot mirror and clear a
  // password before the privacy guard sees its original control and value.
  const activationTarget = typeof owner.addEventListener === "function" ? owner : document;
  activationTarget.addEventListener("beforeinput", inspectInputEvent, true);
  activationTarget.addEventListener("input", inspectInputEvent, true);
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
  const activationKey = (event: Event): "Enter" | "Space" | null => {
    const key = String((event as KeyboardEvent).key || "");
    if (key === "Enter" || key === "\r") return "Enter";
    if ([" ", "Space", "Spacebar"].includes(key)) return "Space";
    return null;
  };
  const stopActivationEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const recordRefusal = (refusal: PreviewAgentInputRefusal): void => {
    if (state.agentInputRefused) return;
    state.agentInputRefused = refusal;
    reportRefusal?.(refusal);
  };
  const activationEventRefusal = (
    event: Event,
  ): "disabled" | "file" | "nested" | null => {
    if (state.nestedContentObserved === true) return "nested";
    let disabled = false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      const candidate = node as Partial<HTMLInputElement> | null;
      const input = inputElement(node);
      if (input?.type.toLowerCase() === "file") return "file";
      if (candidate?.matches?.(":disabled") === true
        || candidate?.disabled === true
        || String(candidate?.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") {
        disabled = true;
      }
    }
    return disabled ? "disabled" : null;
  };
  for (const eventName of ["mousedown", "mouseup", "click"] as const) {
    activationTarget.addEventListener(eventName, (event) => {
      if (!state.agentInputActive || event.isTrusted !== true) return;
      const expectedRef = state.expectedAgentClickRef;
      if (!expectedRef) return;
      const expected = state.refs.get(expectedRef);
      const refusal = state.agentInputRefused
        || activationEventRefusal(event)
        || (!expected?.isConnected || !event.composedPath().includes(expected)
          ? "retargeted"
          : null);
      if (!refusal) return;
      recordRefusal(refusal);
      stopActivationEvent(event);
    }, true);
  }
  activationTarget.addEventListener("keydown", (event) => {
    if (!state.agentInputActive || event.isTrusted !== true) return;
    const key = activationKey(event);
    if (!key) return;
    state.agentActivationKey = key;
    const refusal = activationEventRefusal(event);
    if (!refusal) return;
    recordRefusal(refusal);
    state.blockedAgentActivationKey = key;
    stopActivationEvent(event);
  }, true);
  for (const eventName of ["keypress", "keyup"] as const) {
    activationTarget.addEventListener(eventName, (event) => {
      if (!state.agentInputActive || event.isTrusted !== true) return;
      const key = activationKey(event);
      if (!key || key !== state.agentActivationKey) return;
      const refusal = activationEventRefusal(event);
      if (state.blockedAgentActivationKey === key || refusal) {
        if (refusal) recordRefusal(refusal);
        state.blockedAgentActivationKey = key;
        stopActivationEvent(event);
      }
      if (eventName === "keyup") {
        state.agentActivationKey = undefined;
        state.blockedAgentActivationKey = undefined;
      }
    }, true);
  }
  for (const eventName of ["beforeinput", "input"] as const) {
    activationTarget.addEventListener(eventName, (event) => {
      if (!state.agentInputActive || event.isTrusted !== true || !state.agentActivationKey) return;
      const refusal = activationEventRefusal(event);
      if (!state.blockedAgentActivationKey && !refusal) return;
      if (refusal) recordRefusal(refusal);
      state.blockedAgentActivationKey = state.agentActivationKey;
      stopActivationEvent(event);
    }, true);
  }
  const observer = new MutationObserver((records) => {
    const budget = scanBudget();
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      if (!consume(budget)) break;
      const record = records[recordIndex]!;
      const changedInput = inputElement(record.target);
      if (record.type === "attributes" && changedInput) {
        inspect(changedInput, String(record.oldValue || "").toLowerCase() === "password");
      }
      for (const node of record.removedNodes) {
        if (!consume(budget)) break;
        inspectTree(node, budget);
        if (budget.exhausted) break;
      }
      if (budget.exhausted) break;
      for (const node of record.addedNodes) {
        if (!consume(budget)) break;
        inspectTree(node, budget);
        if (budget.exhausted) break;
      }
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
