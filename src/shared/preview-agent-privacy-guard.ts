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
        const root = Reflect.apply(attachShadow, this, [init]) as ShadowRoot;
        signal();
        return root;
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
  const inputValueDescriptor = typeof HTMLInputElement === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const inputTypeDescriptor = typeof HTMLInputElement === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "type");
  const inputDefaultValueDescriptor = typeof HTMLInputElement === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "defaultValue");
  const inputSetRangeTextDescriptor = typeof HTMLInputElement === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "setRangeText");
  const setAttributeDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "setAttribute",
  );
  const setAttributeNsDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "setAttributeNS",
  );
  const setAttributeNodeDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "setAttributeNode",
  );
  const setAttributeNodeNsDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "setAttributeNodeNS",
  );
  const setNamedItemDescriptor = typeof NamedNodeMap === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(NamedNodeMap.prototype, "setNamedItem");
  const setNamedItemNsDescriptor = typeof NamedNodeMap === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(NamedNodeMap.prototype, "setNamedItemNS");
  const attrValueDescriptor = typeof Attr === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Attr.prototype, "value");
  const attrOwnerElement = typeof Attr === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Attr.prototype, "ownerElement")?.get;
  const nodeValueDescriptor = typeof Node === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Node.prototype, "nodeValue");
  const nodeTextContentDescriptor = typeof Node === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  const objectDefinePropertyDescriptor = Object.getOwnPropertyDescriptor(
    Object,
    "defineProperty",
  );
  const objectDefinePropertiesDescriptor = Object.getOwnPropertyDescriptor(
    Object,
    "defineProperties",
  );
  const reflectDefinePropertyDescriptor = Object.getOwnPropertyDescriptor(
    Reflect,
    "defineProperty",
  );
  const objectSetPrototypeOfDescriptor = Object.getOwnPropertyDescriptor(
    Object,
    "setPrototypeOf",
  );
  const reflectSetPrototypeOfDescriptor = Object.getOwnPropertyDescriptor(
    Reflect,
    "setPrototypeOf",
  );
  const legacyPrototypeDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "__proto__",
  );
  const legacyDefineGetterDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "__defineGetter__",
  );
  const inputValueGetter = inputValueDescriptor?.get;
  const inputValueSetter = inputValueDescriptor?.set;
  const inputTypeGetter = inputTypeDescriptor?.get;
  const inputTypeSetter = inputTypeDescriptor?.set;
  const inputDefaultValueGetter = inputDefaultValueDescriptor?.get;
  const inputDefaultValueSetter = inputDefaultValueDescriptor?.set;
  const inputSetRangeText = inputSetRangeTextDescriptor?.value as
    | HTMLInputElement["setRangeText"]
    | undefined;
  const setAttribute = setAttributeDescriptor?.value as Element["setAttribute"] | undefined;
  const setAttributeNs = setAttributeNsDescriptor?.value as Element["setAttributeNS"] | undefined;
  const setAttributeNode = setAttributeNodeDescriptor?.value as Element["setAttributeNode"] | undefined;
  const setAttributeNodeNs = setAttributeNodeNsDescriptor?.value as Element["setAttributeNodeNS"] | undefined;
  const setNamedItem = setNamedItemDescriptor?.value as NamedNodeMap["setNamedItem"] | undefined;
  const setNamedItemNs = setNamedItemNsDescriptor?.value as NamedNodeMap["setNamedItemNS"] | undefined;
  const attrValueSetter = attrValueDescriptor?.set;
  const nodeValueSetter = nodeValueDescriptor?.set;
  const nodeTextContentSetter = nodeTextContentDescriptor?.set;
  const objectDefineProperty = objectDefinePropertyDescriptor?.value as
    | typeof Object.defineProperty
    | undefined;
  const objectDefineProperties = objectDefinePropertiesDescriptor?.value as
    | typeof Object.defineProperties
    | undefined;
  const reflectDefineProperty = reflectDefinePropertyDescriptor?.value as
    | typeof Reflect.defineProperty
    | undefined;
  const objectSetPrototypeOf = objectSetPrototypeOfDescriptor?.value as
    | typeof Object.setPrototypeOf
    | undefined;
  const reflectSetPrototypeOf = reflectSetPrototypeOfDescriptor?.value as
    | typeof Reflect.setPrototypeOf
    | undefined;
  const legacyPrototypeSetter = legacyPrototypeDescriptor?.set;
  const legacyDefineGetter = legacyDefineGetterDescriptor?.value as
    | ((propertyKey: PropertyKey, getter: () => unknown) => void)
    | undefined;
  const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeIsPrototypeOf = Object.prototype.isPrototypeOf;
  const nativeWeakSetAdd = WeakSet.prototype.add;
  const nativeWeakSetHas = WeakSet.prototype.has;
  const ownValueInputs = new WeakSet<object>();
  const inputPrototype = typeof HTMLInputElement === "undefined"
    ? undefined
    : HTMLInputElement.prototype;
  const nativeString = String;
  const nativeLowerCase = String.prototype.toLowerCase;
  const isNativeInput = (input: unknown): boolean => {
    try {
      return Reflect.apply(nativeIsPrototypeOf, inputPrototype!, [input]) as boolean;
    } catch {
      return false;
    }
  };
  const signalPasswordValue = (input: unknown, knownInput: boolean): void => {
    if (!knownInput && !isNativeInput(input)) return;
    let inputType: string;
    try {
      inputType = nativeString(Reflect.apply(inputTypeGetter!, input, []));
    } catch {
      if (!knownInput) return;
      // A native write already succeeded. If its resulting type/value cannot
      // be proven safe, retain the lifetime taint before author code can log
      // and clear a credential in the same task.
      signal();
      return;
    }
    try {
      const assignedValue = Reflect.apply(inputValueGetter!, input, []) as string;
      const defaultValue = Reflect.apply(inputDefaultValueGetter!, input, []) as string;
      const isPassword = Reflect.apply(nativeLowerCase, inputType, []) === "password";
      const ownValueShadowed = Reflect.apply(
        nativeWeakSetHas,
        ownValueInputs,
        [input as object],
      ) as boolean;
      if (isPassword && (ownValueShadowed || assignedValue || defaultValue)) signal();
    } catch {
      signal();
    }
  };
  const trackOwnInputValue = (input: unknown): void => {
    if (!isNativeInput(input)) return;
    try {
      const ownValue = Reflect.apply(
        nativeGetOwnPropertyDescriptor,
        Object,
        [input, "value"],
      ) as PropertyDescriptor | undefined;
      if (!ownValue) return;
      Reflect.apply(nativeWeakSetAdd, ownValueInputs, [input as object]);
      const inputType = nativeString(Reflect.apply(inputTypeGetter!, input, []));
      if (Reflect.apply(nativeLowerCase, inputType, []) === "password") signal();
    } catch {
      // Once a descriptor mutation has succeeded on a real input, an
      // uninspectable target can hide a page-readable value from every native
      // input accessor. Retain the lifetime taint rather than invoke it.
      signal();
    }
  };
  const signalAttrOwner = (attr: unknown, knownAttr: boolean): void => {
    try {
      const ownerElement = Reflect.apply(attrOwnerElement!, attr, []) as Element | null;
      if (ownerElement) signalPasswordValue(ownerElement, false);
    } catch {
      if (knownAttr) signal();
    }
  };
  if (typeof HTMLInputElement !== "undefined") {
    if (!inputValueDescriptor || typeof inputValueGetter !== "function"
      || typeof inputValueSetter !== "function" || !inputTypeDescriptor
      || typeof inputTypeGetter !== "function" || typeof inputTypeSetter !== "function"
      || !inputDefaultValueDescriptor || typeof inputDefaultValueGetter !== "function"
      || typeof inputDefaultValueSetter !== "function" || !inputSetRangeTextDescriptor
      || typeof inputSetRangeText !== "function" || !setAttributeDescriptor
      || typeof setAttribute !== "function" || !setAttributeNsDescriptor
      || typeof setAttributeNs !== "function" || !setAttributeNodeDescriptor
      || typeof setAttributeNode !== "function" || !setAttributeNodeNsDescriptor
      || typeof setAttributeNodeNs !== "function" || !setNamedItemDescriptor
      || typeof setNamedItem !== "function" || !setNamedItemNsDescriptor
      || typeof setNamedItemNs !== "function" || !attrValueDescriptor
      || typeof attrValueSetter !== "function" || typeof attrOwnerElement !== "function"
      || !nodeValueDescriptor || typeof nodeValueSetter !== "function"
      || !nodeTextContentDescriptor || typeof nodeTextContentSetter !== "function") {
      signal();
    } else {
      try {
        Object.defineProperty(HTMLInputElement.prototype, "value", {
          ...inputValueDescriptor,
          set(this: HTMLInputElement, value: unknown): void {
            Reflect.apply(inputValueSetter, this, [value]);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(HTMLInputElement.prototype, "type", {
          ...inputTypeDescriptor,
          set(this: HTMLInputElement, value: unknown): void {
            Reflect.apply(inputTypeSetter, this, [value]);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(HTMLInputElement.prototype, "defaultValue", {
          ...inputDefaultValueDescriptor,
          set(this: HTMLInputElement, value: unknown): void {
            Reflect.apply(inputDefaultValueSetter, this, [value]);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(HTMLInputElement.prototype, "setRangeText", {
          ...inputSetRangeTextDescriptor,
          value(this: HTMLInputElement, ...args: unknown[]): void {
            Reflect.apply(inputSetRangeText, this, args);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(Element.prototype, "setAttribute", {
          ...setAttributeDescriptor,
          value(this: Element, name: string, value: string): void {
            Reflect.apply(setAttribute, this, [name, value]);
            signalPasswordValue(this, false);
          },
        });
        Object.defineProperty(Element.prototype, "setAttributeNS", {
          ...setAttributeNsDescriptor,
          value(this: Element, namespace: string | null, qualifiedName: string, value: string): void {
            Reflect.apply(setAttributeNs, this, [namespace, qualifiedName, value]);
            signalPasswordValue(this, false);
          },
        });
        Object.defineProperty(Element.prototype, "setAttributeNode", {
          ...setAttributeNodeDescriptor,
          value(this: Element, attr: Attr): Attr | null {
            const replaced = Reflect.apply(setAttributeNode, this, [attr]) as Attr | null;
            signalPasswordValue(this, false);
            return replaced;
          },
        });
        Object.defineProperty(Element.prototype, "setAttributeNodeNS", {
          ...setAttributeNodeNsDescriptor,
          value(this: Element, attr: Attr): Attr | null {
            const replaced = Reflect.apply(setAttributeNodeNs, this, [attr]) as Attr | null;
            signalPasswordValue(this, false);
            return replaced;
          },
        });
        Object.defineProperty(NamedNodeMap.prototype, "setNamedItem", {
          ...setNamedItemDescriptor,
          value(this: NamedNodeMap, attr: Attr): Attr | null {
            const replaced = Reflect.apply(setNamedItem, this, [attr]) as Attr | null;
            signalAttrOwner(attr, true);
            return replaced;
          },
        });
        Object.defineProperty(NamedNodeMap.prototype, "setNamedItemNS", {
          ...setNamedItemNsDescriptor,
          value(this: NamedNodeMap, attr: Attr): Attr | null {
            const replaced = Reflect.apply(setNamedItemNs, this, [attr]) as Attr | null;
            signalAttrOwner(attr, true);
            return replaced;
          },
        });
        Object.defineProperty(Attr.prototype, "value", {
          ...attrValueDescriptor,
          set(this: Attr, value: string): void {
            Reflect.apply(attrValueSetter, this, [value]);
            signalAttrOwner(this, true);
          },
        });
        Object.defineProperty(Node.prototype, "nodeValue", {
          ...nodeValueDescriptor,
          set(this: Node, value: string | null): void {
            Reflect.apply(nodeValueSetter, this, [value]);
            if (Reflect.apply(nativeIsPrototypeOf, Attr.prototype, [this])) {
              signalAttrOwner(this, true);
            }
          },
        });
        Object.defineProperty(Node.prototype, "textContent", {
          ...nodeTextContentDescriptor,
          set(this: Node, value: string | null): void {
            Reflect.apply(nodeTextContentSetter, this, [value]);
            if (Reflect.apply(nativeIsPrototypeOf, Attr.prototype, [this])) {
              signalAttrOwner(this, true);
            }
          },
        });
      } catch {
        signal();
      }
    }
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
  const mayCreatePrivateContent = (value: unknown): boolean => {
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
          elements: [
            { name: "template", attributes: ["shadowrootmode"] },
            { name: "input", attributes: ["type", "value"] },
          ],
        },
      }]);
      const content = Reflect.apply(templateContent, template, []) as DocumentFragment;
      return Reflect.apply(querySelector, content, [
        "template[shadowrootmode],input[type='password' i][value]:not([value=''])",
      ]) !== null;
    } catch {
      return true;
    }
  };
  const signalPrivateParser = (prototype: object, name: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const parser = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
    if (!descriptor || typeof parser !== "function") return;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]): unknown {
        // These APIs can create private content entirely outside the observed
        // document. Signal before author code can read, log, and remove it.
        // Keep ordinary parser use available, but fail closed when bounded
        // source inspection cannot prove that private syntax is absent.
        if (mayCreatePrivateContent(args[0])) signal();
        return Reflect.apply(parser, this, args);
      },
    });
  };
  signalPrivateParser(Element.prototype, "setHTML");
  signalPrivateParser(Element.prototype, "setHTMLUnsafe");
  if (typeof Document !== "undefined") {
    signalPrivateParser(Document, "parseHTML");
    signalPrivateParser(Document, "parseHTMLUnsafe");
  }
  if (typeof ShadowRoot !== "undefined") {
    signalPrivateParser(ShadowRoot.prototype, "setHTML");
    signalPrivateParser(ShadowRoot.prototype, "setHTMLUnsafe");
  }
  const signalParserSetter = (prototype: object, name: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const setter = descriptor?.set;
    if (!descriptor || typeof setter !== "function") return;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      set(this: unknown, value: unknown): void {
        if (mayCreatePrivateContent(value)) signal();
        Reflect.apply(setter, this, [value]);
      },
    });
  };
  const signalParserMethod = (prototype: object, name: string, sourceIndex = 0): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const parser = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
    if (!descriptor || typeof parser !== "function") return;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]): unknown {
        if (mayCreatePrivateContent(args[sourceIndex])) signal();
        return Reflect.apply(parser, this, args);
      },
    });
  };
  signalParserSetter(Element.prototype, "innerHTML");
  signalParserSetter(Element.prototype, "outerHTML");
  signalParserMethod(Element.prototype, "insertAdjacentHTML", 1);
  if (typeof Range !== "undefined") {
    signalParserMethod(Range.prototype, "createContextualFragment");
  }
  if (typeof DOMParser !== "undefined") {
    signalParserMethod(DOMParser.prototype, "parseFromString");
  }
  const signalParserArguments = (prototype: object, name: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const parser = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
    if (!descriptor || typeof parser !== "function") return;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value(this: unknown, ...args: unknown[]): unknown {
        let source = "";
        let unsafe = false;
        for (const argument of args) {
          if (typeof argument !== "string"
            || source.length + argument.length > maximumParserSourceCharacters) {
            unsafe = true;
            break;
          }
          source += argument;
        }
        if (unsafe || mayCreatePrivateContent(source)) signal();
        return Reflect.apply(parser, this, args);
      },
    });
  };
  if (typeof Document !== "undefined") {
    signalParserArguments(Document.prototype, "write");
    signalParserArguments(Document.prototype, "writeln");
  }
  if (typeof HTMLInputElement !== "undefined") {
    if (!objectDefinePropertyDescriptor || typeof objectDefineProperty !== "function"
      || !objectDefinePropertiesDescriptor || typeof objectDefineProperties !== "function"
      || !reflectDefinePropertyDescriptor || typeof reflectDefineProperty !== "function"
      || !objectSetPrototypeOfDescriptor || typeof objectSetPrototypeOf !== "function"
      || !reflectSetPrototypeOfDescriptor || typeof reflectSetPrototypeOf !== "function"
      || !legacyPrototypeDescriptor || typeof legacyPrototypeSetter !== "function"
      || !legacyDefineGetterDescriptor || typeof legacyDefineGetter !== "function") {
      signal();
    } else {
      try {
        Reflect.apply(objectDefineProperty, Object, [Object, "defineProperty", {
          ...objectDefinePropertyDescriptor,
          value(target: object, propertyKey: PropertyKey, attributes: PropertyDescriptor): object {
            const defined = Reflect.apply(objectDefineProperty, Object, [
              target,
              propertyKey,
              attributes,
            ]) as object;
            trackOwnInputValue(defined);
            return defined;
          },
        }]);
        Reflect.apply(objectDefineProperty, Object, [Object, "defineProperties", {
          ...objectDefinePropertiesDescriptor,
          value(target: object, properties: PropertyDescriptorMap): object {
            const defined = Reflect.apply(objectDefineProperties, Object, [
              target,
              properties,
            ]) as object;
            trackOwnInputValue(defined);
            return defined;
          },
        }]);
        Reflect.apply(objectDefineProperty, Object, [Reflect, "defineProperty", {
          ...reflectDefinePropertyDescriptor,
          value(target: object, propertyKey: PropertyKey, attributes: PropertyDescriptor): boolean {
            const defined = Reflect.apply(reflectDefineProperty, Reflect, [
              target,
              propertyKey,
              attributes,
            ]) as boolean;
            if (defined) trackOwnInputValue(target);
            return defined;
          },
        }]);
        Reflect.apply(objectDefineProperty, Object, [Object, "setPrototypeOf", {
          ...objectSetPrototypeOfDescriptor,
          value(target: object, prototype: object | null): object {
            const input = isNativeInput(target);
            const updated = Reflect.apply(objectSetPrototypeOf, Object, [
              target,
              prototype,
            ]) as object;
            if (input) signal();
            return updated;
          },
        }]);
        Reflect.apply(objectDefineProperty, Object, [Reflect, "setPrototypeOf", {
          ...reflectSetPrototypeOfDescriptor,
          value(target: object, prototype: object | null): boolean {
            const input = isNativeInput(target);
            const updated = Reflect.apply(reflectSetPrototypeOf, Reflect, [
              target,
              prototype,
            ]) as boolean;
            if (input && updated) signal();
            return updated;
          },
        }]);
        Reflect.apply(objectDefineProperty, Object, [Object.prototype, "__proto__", {
          ...legacyPrototypeDescriptor,
          set(this: object, prototype: object | null): void {
            const input = isNativeInput(this);
            Reflect.apply(legacyPrototypeSetter, this, [prototype]);
            if (input) signal();
          },
        }]);
        Reflect.apply(objectDefineProperty, Object, [Object.prototype, "__defineGetter__", {
          ...legacyDefineGetterDescriptor,
          value(this: object, propertyKey: PropertyKey, getter: () => unknown): void {
            Reflect.apply(legacyDefineGetter, this, [propertyKey, getter]);
            trackOwnInputValue(this);
          },
        }]);
      } catch {
        signal();
      }
    }
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
  const exactToken = (value: unknown, expected: string, maximum: number): boolean => (
    typeof value === "string" && value.length <= maximum
    && value.trim().toLowerCase() === expected
  );
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
      || exactToken(input.type, "password", 20)
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
  const activationTarget = typeof owner.addEventListener === "function" ? owner : document;
  const boundedEventPath = (event: Event): EventTarget[] | null => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.length <= maximumScanNodes ? path : null;
  };
  activationTarget.addEventListener(nestedBoundaryEvent, () => {
    state.nestedContentObserved = true;
  }, true);
  if (document.documentElement) inspectTree(document.documentElement, scanBudget());
  const inspectInputEvent = (event: Event): void => {
    let exposedControl = false;
    const path = boundedEventPath(event);
    if (!path) {
      if (event.isTrusted === true) state.nestedContentObserved = true;
      return;
    }
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
    // path. Retain a lifetime taint for trusted native delivery before an
    // author handler can mirror the value and remove the host; synthetic page
    // events cannot permanently disable Browser evidence.
    if (!exposedControl && event.isTrusted === true) state.nestedContentObserved = true;
  };
  // Preload installs this before author scripts. Observe from the earliest
  // capture boundary so a page-owned window handler cannot mirror and clear a
  // password before the privacy guard sees its original control and value.
  activationTarget.addEventListener("beforeinput", inspectInputEvent, true);
  activationTarget.addEventListener("input", inspectInputEvent, true);
  document.addEventListener("click", (event) => {
    if (!state.agentInputActive) return;
    const path = boundedEventPath(event);
    if (!path) {
      if (event.isTrusted === true) {
        state.nestedContentObserved = true;
        recordRefusal("nested");
        stopActivationEvent(event);
      }
      return;
    }
    let fileInput = false;
    for (const node of path) {
      if (exactToken(inputElement(node)?.type, "file", 20)) {
        fileInput = true;
        break;
      }
    }
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
  const ariaDisabled = (candidate: Partial<Element> | null): boolean => {
    const value = candidate?.getAttribute?.("aria-disabled");
    return exactToken(value, "true", 10);
  };
  const activationEventRefusal = (
    event: Event,
    suppliedPath: EventTarget[] | null = boundedEventPath(event),
  ): "disabled" | "file" | "nested" | null => {
    if (state.nestedContentObserved === true) return "nested";
    if (!suppliedPath) {
      state.nestedContentObserved = true;
      return "nested";
    }
    let disabled = false;
    for (const node of suppliedPath) {
      const candidate = node as Partial<HTMLInputElement> | null;
      const input = inputElement(node);
      if (exactToken(input?.type, "file", 20)) return "file";
      if (candidate?.matches?.(":disabled") === true
        || candidate?.disabled === true
        || ariaDisabled(candidate)) {
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
      const path = boundedEventPath(event);
      const refusal = state.agentInputRefused
        || activationEventRefusal(event, path)
        || (!expected?.isConnected || path === null || !path.includes(expected)
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
        inspect(changedInput, exactToken(record.oldValue, "password", 20));
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
