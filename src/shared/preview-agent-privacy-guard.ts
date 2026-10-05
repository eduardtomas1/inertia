import type {
  createPreviewAgentPrivacyRuntime,
  PreviewAgentSensitiveInspection,
} from "./preview-agent-sensitive-fields.js";

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
  agentActivationTarget?: EventTarget;
  blockedAgentActivationKey?: "Enter" | "Space";
  expectedAgentClickRef?: string;
  agentInputRefused?: "disabled" | "file" | "nested" | "retargeted";
  evidenceWithheld?: PreviewAgentWithheldReason;
  framesObserved?: boolean;
  shadowRootsObserved?: boolean;
  scanLimitReached?: boolean;
}

type AgentBrowserPrivacyGlobal = typeof globalThis & {
  __inertiaAgentBrowser?: AgentBrowserPrivacyState;
};

export const PREVIEW_AGENT_NESTED_BOUNDARY_EVENT = "__inertia_agent_nested_boundary__";
export const PREVIEW_AGENT_CREDENTIAL_SIGNAL_EVENT = "__inertia_agent_credential_signal__";
export type PreviewAgentWithheldReason = "credential-signal" | "hidden-input" | "document-too-large" | "redaction-limit";
export const PREVIEW_AGENT_INPUT_REFUSAL_CHANNEL = "inertia:preview-agent-input-refusal";
export type PreviewAgentInputRefusal = "disabled" | "file" | "nested" | "retargeted";

/** Runs in the page's main world before author scripts. */
export function installPreviewAgentShadowBoundarySignal(
  eventName: string,
  credentialEventName: string,
  nameSource: string,
  wordSource: string,
): void {
  const apply = Reflect.apply;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const EventConstructor = Event;
  const CustomEventConstructor = typeof CustomEvent === "function" ? CustomEvent : undefined;
  const stringify = JSON.stringify;
  const regExpExec = RegExp.prototype.exec;
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  const iteratorSymbol = Symbol.iterator;
  const arrayValues = Array.prototype[Symbol.iterator];
  const arrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]()) as object;
  const arrayIteratorNext = Object.getOwnPropertyDescriptor(arrayIteratorPrototype, "next")?.value as unknown;
  const signalShadowBoundary = (): void => {
    apply(dispatch, document, [new EventConstructor(eventName)]);
  };
  const signal = (): void => {
    apply(dispatch, document, [new EventConstructor(credentialEventName)]);
  };
  const signalValues = (first: string, second?: string): void => {
    if (!CustomEventConstructor) {
      signal();
      return;
    }
    const detail = second === undefined
      ? "[" + stringify(first) + "]"
      : "[" + stringify(first) + "," + stringify(second) + "]";
    apply(dispatch, document, [new CustomEventConstructor(
      credentialEventName,
      { __proto__: null, detail } as unknown as CustomEventInit,
    )]);
  };
  let sensitiveNamePattern: RegExp | null = null;
  let nameWordPattern: RegExp | null = null;
  try {
    if (typeof nameSource !== "string" || typeof wordSource !== "string") throw new TypeError();
    sensitiveNamePattern = new RegExp(nameSource, "u");
    nameWordPattern = new RegExp(wordSource, "gu");
  } catch {
    signal();
  }
  const shadowDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  const attachShadow = shadowDescriptor?.value as Element["attachShadow"] | undefined;
  if (shadowDescriptor && typeof attachShadow === "function") {
    Object.defineProperty(Element.prototype, "attachShadow", {
      ...shadowDescriptor,
      value(this: Element, init: ShadowRootInit): ShadowRoot {
        const root = apply(attachShadow, this, [init]) as ShadowRoot;
        signalShadowBoundary();
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
        const internals = apply(attachInternals, this, []) as ElementInternals;
        if (internals.shadowRoot) signalShadowBoundary();
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
  interface MonitoredValue { get: () => unknown; set: (value: unknown) => void; last: unknown }
  const monitoredValues = new WeakMap<object, MonitoredValue>();
  const nativeWeakMapGet = WeakMap.prototype.get;
  const nativeWeakMapSet = WeakMap.prototype.set;
  const inputPrototype = typeof HTMLInputElement === "undefined"
    ? undefined
    : HTMLInputElement.prototype;
  const nativeString = String;
  const nativeLowerCase = String.prototype.toLowerCase;
  const getAttribute = Element.prototype.getAttribute;
  const nameAttributes = ["id", "name", "autocomplete", "placeholder", "aria-label"];
  const sensitiveName = (value: string): boolean => {
    if (!sensitiveNamePattern || !nameWordPattern) return true;
    let words = "";
    nameWordPattern.lastIndex = 0;
    for (let match = apply(regExpExec, nameWordPattern, [value]) as RegExpExecArray | null; match !== null;
      match = apply(regExpExec, nameWordPattern, [value]) as RegExpExecArray | null) {
      if (match[0] === "") break;
      words = words === "" ? match[0] : words + " " + match[0];
    }
    return apply(regExpExec, sensitiveNamePattern, [apply(nativeLowerCase, words, [])]) !== null;
  };
  const sensitiveInput = (input: unknown): boolean => {
    const type = apply(nativeLowerCase, nativeString(apply(inputTypeGetter!, input, [])), []) as string;
    if (type === "password") return true;
    if (type !== "text" && type !== "search" && type !== "email" && type !== "url"
      && type !== "tel" && type !== "number" && type !== "hidden") return false;
    if (typeof getAttribute !== "function") return false;
    for (let index = 0; index < nameAttributes.length; index += 1) {
      const value = apply(getAttribute, input, [nameAttributes[index]]) as unknown;
      if (typeof value === "string" && (value.length > 1_200 || sensitiveName(value))) return true;
    }
    return false;
  };
  const signalValue = (input: unknown, value: unknown): void => {
    if (value === null || value === undefined || !sensitiveInput(input)) return;
    const kind = typeof value;
    const text = kind === "string" ? value as string
      : kind === "number" || kind === "boolean" || kind === "bigint" ? nativeString(value) : null;
    if (text === null || text.length > 4_096) signal();
    else if (text) signalValues(text);
  };
  const isNativeInput = (input: unknown): boolean => {
    try {
      return apply(nativeIsPrototypeOf, inputPrototype!, [input]) as boolean;
    } catch {
      return false;
    }
  };
  const signalPasswordValue = (input: unknown, knownInput: boolean): void => {
    if (!knownInput && !isNativeInput(input)) return;
    let inputType: string;
    try {
      inputType = nativeString(apply(inputTypeGetter!, input, []));
    } catch {
      if (!knownInput) return;
      // A native write already succeeded. If its resulting type/value cannot
      // be proven safe, retain the lifetime taint before author code can log
      // and clear a credential in the same task.
      signal();
      return;
    }
    try {
      const assignedValue = apply(inputValueGetter!, input, []) as string;
      const defaultValue = apply(inputDefaultValueGetter!, input, []) as string;
      const isPassword = apply(nativeLowerCase, inputType, []) === "password" || sensitiveInput(input);
      const ownValueShadowed = apply(
        nativeWeakSetHas,
        ownValueInputs,
        [input as object],
      ) as boolean;
      if (!isPassword) return;
      const monitored = apply(nativeWeakMapGet, monitoredValues, [input as object]) as
        MonitoredValue | undefined;
      if (ownValueShadowed && !monitored) signal();
      else {
        if (assignedValue || defaultValue) {
          if (assignedValue.length > 4_096 || defaultValue.length > 4_096) signal();
          else signalValues(assignedValue, defaultValue);
        }
        if (monitored && monitored.last !== "") signalValue(input, monitored.last);
      }
    } catch {
      signal();
    }
  };
  const monitor = (
    pageGet: (this: unknown) => unknown,
    pageSet: (this: unknown, value: unknown) => void,
    last: unknown,
  ): MonitoredValue => {
    const record: MonitoredValue = {
      last,
      get(this: unknown): unknown {
        const value = apply(pageGet, this, []);
        try {
          if (value !== apply(inputValueGetter!, this, [])) {
            record.last = value;
            signalValue(this, value);
          }
        } catch {
          signal();
        }
        return value;
      },
      set(this: unknown, value: unknown): void {
        try {
          record.last = value;
          signalValue(this, value);
        } catch {
          signal();
        }
        try {
          apply(pageSet, this, [value]);
        } finally {
          signalPasswordValue(this, true);
        }
      },
    };
    return record;
  };
  const trackOwnInputValue = (input: unknown): void => {
    if (!isNativeInput(input)) return;
    try {
      const ownValue = apply(
        nativeGetOwnPropertyDescriptor,
        Object,
        [input, "value"],
      ) as PropertyDescriptor | undefined;
      if (!ownValue) return;
      apply(nativeWeakSetAdd, ownValueInputs, [input as object]);
      const existing = apply(nativeWeakMapGet, monitoredValues, [input as object]) as
        MonitoredValue | undefined;
      const getter = apply(hasOwnProperty, ownValue, ["get"]) ? ownValue.get : undefined;
      const setter = apply(hasOwnProperty, ownValue, ["set"]) ? ownValue.set : undefined;
      if (existing && existing.get === getter && existing.set === setter) {
        signalPasswordValue(input, true);
        return;
      }
      if (ownValue.configurable === true && typeof getter === "function" && typeof setter === "function") {
        const record = monitor(getter, setter, existing ? existing.last : "");
        apply(objectDefineProperty!, Object, [input, "value", {
          __proto__: null,
          configurable: true,
          enumerable: ownValue.enumerable === true,
          get: record.get,
          set: record.set,
        }]);
        apply(nativeWeakMapSet, monitoredValues, [input as object, record]);
      } else {
        apply(nativeWeakMapSet, monitoredValues, [input as object, undefined]);
      }
      signalPasswordValue(input, true);
    } catch {
      // Once a descriptor mutation has succeeded on a real input, an
      // uninspectable target can hide a page-readable value from every native
      // input accessor. Retain the lifetime taint rather than invoke it.
      signal();
    }
  };
  const signalAttrOwner = (attr: unknown, knownAttr: boolean): void => {
    try {
      const ownerElement = apply(attrOwnerElement!, attr, []) as Element | null;
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
            apply(inputValueSetter, this, [value]);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(HTMLInputElement.prototype, "type", {
          ...inputTypeDescriptor,
          set(this: HTMLInputElement, value: unknown): void {
            apply(inputTypeSetter, this, [value]);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(HTMLInputElement.prototype, "defaultValue", {
          ...inputDefaultValueDescriptor,
          set(this: HTMLInputElement, value: unknown): void {
            apply(inputDefaultValueSetter, this, [value]);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(HTMLInputElement.prototype, "setRangeText", {
          ...inputSetRangeTextDescriptor,
          value(this: HTMLInputElement, ...args: unknown[]): void {
            apply(inputSetRangeText, this, args);
            signalPasswordValue(this, true);
          },
        });
        Object.defineProperty(Element.prototype, "setAttribute", {
          ...setAttributeDescriptor,
          value(this: Element, name: string, value: string): void {
            apply(setAttribute, this, [name, value]);
            signalPasswordValue(this, false);
          },
        });
        Object.defineProperty(Element.prototype, "setAttributeNS", {
          ...setAttributeNsDescriptor,
          value(this: Element, namespace: string | null, qualifiedName: string, value: string): void {
            apply(setAttributeNs, this, [namespace, qualifiedName, value]);
            signalPasswordValue(this, false);
          },
        });
        Object.defineProperty(Element.prototype, "setAttributeNode", {
          ...setAttributeNodeDescriptor,
          value(this: Element, attr: Attr): Attr | null {
            const replaced = apply(setAttributeNode, this, [attr]) as Attr | null;
            signalPasswordValue(this, false);
            return replaced;
          },
        });
        Object.defineProperty(Element.prototype, "setAttributeNodeNS", {
          ...setAttributeNodeNsDescriptor,
          value(this: Element, attr: Attr): Attr | null {
            const replaced = apply(setAttributeNodeNs, this, [attr]) as Attr | null;
            signalPasswordValue(this, false);
            return replaced;
          },
        });
        Object.defineProperty(NamedNodeMap.prototype, "setNamedItem", {
          ...setNamedItemDescriptor,
          value(this: NamedNodeMap, attr: Attr): Attr | null {
            const replaced = apply(setNamedItem, this, [attr]) as Attr | null;
            signalAttrOwner(attr, true);
            return replaced;
          },
        });
        Object.defineProperty(NamedNodeMap.prototype, "setNamedItemNS", {
          ...setNamedItemNsDescriptor,
          value(this: NamedNodeMap, attr: Attr): Attr | null {
            const replaced = apply(setNamedItemNs, this, [attr]) as Attr | null;
            signalAttrOwner(attr, true);
            return replaced;
          },
        });
        Object.defineProperty(Attr.prototype, "value", {
          ...attrValueDescriptor,
          set(this: Attr, value: string): void {
            apply(attrValueSetter, this, [value]);
            signalAttrOwner(this, true);
          },
        });
        Object.defineProperty(Node.prototype, "nodeValue", {
          ...nodeValueDescriptor,
          set(this: Node, value: string | null): void {
            apply(nodeValueSetter, this, [value]);
            if (apply(nativeIsPrototypeOf, Attr.prototype, [this])) {
              signalAttrOwner(this, true);
            }
          },
        });
        Object.defineProperty(Node.prototype, "textContent", {
          ...nodeTextContentDescriptor,
          set(this: Node, value: string | null): void {
            apply(nodeTextContentSetter, this, [value]);
            if (apply(nativeIsPrototypeOf, Attr.prototype, [this])) {
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
  const sequence = (...items: unknown[]): unknown[] => {
    apply(objectDefineProperty!, Object, [items, iteratorSymbol, { __proto__: null, value: arrayValues }]);
    return items;
  };
  const signalPrivateContent = (value: unknown): void => {
    if (typeof value !== "string" || value.length > maximumParserSourceCharacters) return;
    if (typeof createElement !== "function" || typeof getImplementation !== "function"
      || typeof createHTMLDocument !== "function" || typeof parseSafeHTML !== "function"
      || typeof templateContent !== "function" || typeof querySelector !== "function") {
      signal();
      return;
    }
    try {
      // Parse in a fresh in-memory document with no browsing context or page
      // CSP. Its Trusted Types state cannot invoke a page-owned default policy,
      // while Chromium's tokenizer still decides exact start-tag attributes.
      const implementation = apply(getImplementation, document, []) as DOMImplementation;
      const isolatedDocument = apply(createHTMLDocument, implementation, [""]) as Document;
      const template = apply(
        createElement,
        isolatedDocument,
        ["template"],
      ) as HTMLTemplateElement;
      const next = apply(nativeGetOwnPropertyDescriptor, Object, [arrayIteratorPrototype, "next"]) as
        PropertyDescriptor | undefined;
      if (!next || !apply(hasOwnProperty, next, ["value"]) || next.value !== arrayIteratorNext) {
        signal();
        return;
      }
      apply(parseSafeHTML, template, [value, {
        __proto__: null,
        sanitizer: {
          __proto__: null,
          elements: sequence(
            { __proto__: null, name: "template", attributes: sequence("shadowrootmode") },
            { __proto__: null, name: "input", attributes: sequence("type", "value") },
          ),
        },
      }]);
      const content = apply(templateContent, template, []) as DocumentFragment;
      if (apply(querySelector, content, [
        "input[type='password' i][value]:not([value=''])",
      ]) !== null) signal();
      else if (apply(querySelector, content, ["template[shadowrootmode]"]) !== null) {
        signalShadowBoundary();
      }
    } catch {
      signal();
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
        signalPrivateContent(args[0]);
        return apply(parser, this, args);
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
        signalPrivateContent(value);
        apply(setter, this, [value]);
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
        signalPrivateContent(args[sourceIndex]);
        return apply(parser, this, args);
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
        let inspectable = true;
        for (let index = 0; index < args.length; index += 1) {
          const argument = args[index];
          if (typeof argument !== "string"
            || source.length + argument.length > maximumParserSourceCharacters) {
            inspectable = false;
            break;
          }
          source += argument;
        }
        if (inspectable) signalPrivateContent(source);
        return apply(parser, this, args);
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
        apply(objectDefineProperty, Object, [Object, "defineProperty", {
          ...objectDefinePropertyDescriptor,
          value(target: object, propertyKey: PropertyKey, attributes: PropertyDescriptor): object {
            const defined = apply(objectDefineProperty, Object, [
              target,
              propertyKey,
              attributes,
            ]) as object;
            trackOwnInputValue(defined);
            return defined;
          },
        }]);
        apply(objectDefineProperty, Object, [Object, "defineProperties", {
          ...objectDefinePropertiesDescriptor,
          value(target: object, properties: PropertyDescriptorMap): object {
            const defined = apply(objectDefineProperties, Object, [
              target,
              properties,
            ]) as object;
            trackOwnInputValue(defined);
            return defined;
          },
        }]);
        apply(objectDefineProperty, Object, [Reflect, "defineProperty", {
          ...reflectDefinePropertyDescriptor,
          value(target: object, propertyKey: PropertyKey, attributes: PropertyDescriptor): boolean {
            const defined = apply(reflectDefineProperty, Reflect, [
              target,
              propertyKey,
              attributes,
            ]) as boolean;
            if (defined) trackOwnInputValue(target);
            return defined;
          },
        }]);
        apply(objectDefineProperty, Object, [Object, "setPrototypeOf", {
          ...objectSetPrototypeOfDescriptor,
          value(target: object, prototype: object | null): object {
            const input = isNativeInput(target);
            const updated = apply(objectSetPrototypeOf, Object, [
              target,
              prototype,
            ]) as object;
            if (input) signal();
            return updated;
          },
        }]);
        apply(objectDefineProperty, Object, [Reflect, "setPrototypeOf", {
          ...reflectSetPrototypeOfDescriptor,
          value(target: object, prototype: object | null): boolean {
            const input = isNativeInput(target);
            const updated = apply(reflectSetPrototypeOf, Reflect, [
              target,
              prototype,
            ]) as boolean;
            if (input && updated) signal();
            return updated;
          },
        }]);
        apply(objectDefineProperty, Object, [Object.prototype, "__proto__", {
          ...legacyPrototypeDescriptor,
          set(this: object, prototype: object | null): void {
            const input = isNativeInput(this);
            apply(legacyPrototypeSetter, this, [prototype]);
            if (input) signal();
          },
        }]);
        apply(objectDefineProperty, Object, [Object.prototype, "__defineGetter__", {
          ...legacyDefineGetterDescriptor,
          value(this: object, propertyKey: PropertyKey, getter: () => unknown): void {
            apply(legacyDefineGetter, this, [propertyKey, getter]);
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
  privacy: ReturnType<typeof createPreviewAgentPrivacyRuntime>,
  reportRefusal?: (refusal: PreviewAgentInputRefusal) => void,
): void {
  const owner = globalThis as AgentBrowserPrivacyGlobal;
  const nestedBoundaryEvent = "__inertia_agent_nested_boundary__";
  const credentialSignalEvent = "__inertia_agent_credential_signal__";
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
  const maximumScanNodes = 4_000;
  const exactToken = (value: unknown, expected: string, maximum: number): boolean => (
    typeof value === "string" && value.length <= maximum
    && value.trim().toLowerCase() === expected
  );
  const inspect = (
    input: HTMLInputElement,
    wasPassword = false,
    inspection: PreviewAgentSensitiveInspection = "observe",
  ): void => {
    if (wasPassword) state.passwordNodes.add(input);
    privacy.inspect(state, input, inspection);
  };
  const inputElement = (node: unknown): HTMLInputElement | null => {
    const candidate = node as Partial<HTMLInputElement> | null;
    return candidate?.tagName === "INPUT" || candidate?.tagName === "TEXTAREA" ? candidate as HTMLInputElement : null;
  };
  interface ScanBudget { exhausted: boolean; remaining: number }
  const scanBudget = (): ScanBudget => ({ exhausted: false, remaining: maximumScanNodes });
  const withhold = (reason: PreviewAgentWithheldReason): void => {
    state.evidenceWithheld ??= reason;
  };
  const consume = (budget: ScanBudget): boolean => {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      state.scanLimitReached = true;
      return false;
    }
    budget.remaining -= 1;
    return true;
  };
  const inspectInputs = (root: Partial<Pick<Element, "getElementsByTagName">>): boolean => {
    if (typeof root.getElementsByTagName !== "function") return false;
    let scanned = 0;
    for (const tag of ["input", "textarea"]) {
      const inputs = root.getElementsByTagName(tag);
      for (let index = 0; index < inputs.length; index += 1) {
        if (scanned++ >= maximumScanNodes) {
          withhold("document-too-large");
          return true;
        }
        inspect(inputs[index] as HTMLInputElement);
      }
    }
    return true;
  };
  const inspectTree = (node: Node, budget: ScanBudget): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const inputsInspected = inspectInputs(element);
    const iterator = typeof document.createNodeIterator === "function"
      ? document.createNodeIterator(element, 1)
      : null;
    if (!iterator) {
      budget.exhausted = true;
      withhold("credential-signal");
      return;
    }
    while (true) {
      const descendant = iterator.nextNode() as Element | null;
      if (!descendant) return;
      if (!consume(budget)) {
        if (!inputsInspected) withhold("document-too-large");
        return;
      }
      if (descendant.matches?.("iframe,frame,object,embed")) state.framesObserved = true;
      if (descendant.matches?.("template[shadowrootmode]") || descendant.shadowRoot) {
        state.shadowRootsObserved = true;
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
    state.shadowRootsObserved = true;
  }, true);
  activationTarget.addEventListener(credentialSignalEvent, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    let remembered = false;
    if (typeof detail === "string" && detail.length <= 50_000) {
      try {
        const values: unknown = JSON.parse(detail);
        if (Array.isArray(values) && values.length > 0 && values.length <= 2
          && values.every((value) => typeof value === "string" && value.length <= 4_096)) {
          for (const value of values as string[]) {
            if (!value) continue;
            privacy.remember(state, value, "signal");
            remembered = true;
          }
        }
      } catch {
        remembered = false;
      }
    }
    if (!remembered) withhold("credential-signal");
  }, true);
  if (document.documentElement) inspectTree(document.documentElement, scanBudget());
  const inspectInputEvent = (event: Event): void => {
    let exposedControl = false;
    const path = boundedEventPath(event);
    if (!path) {
      if (event.isTrusted === true) withhold("hidden-input");
      return;
    }
    const inspection = event.isTrusted === true ? "type" : "observe";
    for (const node of path) {
      const input = inputElement(node);
      if (input) {
        exposedControl = true;
        inspect(input, false, inspection);
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
    if (!exposedControl && event.isTrusted === true) withhold("hidden-input");
  };
  // Preload installs this before author scripts. Observe from the earliest
  // capture boundary so a page-owned window handler cannot mirror and clear a
  // password before the privacy guard sees its original control and value.
  activationTarget.addEventListener("beforeinput", inspectInputEvent, true);
  activationTarget.addEventListener("input", inspectInputEvent, true);
  activationTarget.addEventListener("change", (event) => {
    const path = boundedEventPath(event);
    for (let index = 0; path && index < path.length; index += 1) {
      const input = inputElement(path[index]);
      if (input) inspect(input, false, "settle");
    }
  }, true);
  document.addEventListener("click", (event) => {
    if (!state.agentInputActive) return;
    const path = boundedEventPath(event);
    if (!path) {
      if (event.isTrusted === true) {
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
    if (!suppliedPath) return "nested";
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
  const activationRetargeted = (path: EventTarget[] | null): boolean => (
    state.agentActivationTarget !== undefined
    && (path === null || !path.includes(state.agentActivationTarget))
  );
  for (const eventName of ["mousedown", "mouseup", "click"] as const) {
    activationTarget.addEventListener(eventName, (event) => {
      if (!state.agentInputActive || event.isTrusted !== true) return;
      const expectedRef = state.expectedAgentClickRef;
      if (!expectedRef && state.agentActivationTarget === undefined) return;
      const expected = expectedRef ? state.refs.get(expectedRef) : undefined;
      const path = boundedEventPath(event);
      const refusal = state.agentInputRefused
        || activationEventRefusal(event, path)
        || (activationRetargeted(path) ? "retargeted" : null)
        || (expectedRef && (!expected?.isConnected || path === null || !path.includes(expected))
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
    const path = boundedEventPath(event);
    state.agentActivationTarget = path?.[0];
    const refusal = activationEventRefusal(event, path);
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
      const path = boundedEventPath(event);
      const refusal = activationEventRefusal(event, path)
        || (activationRetargeted(path) ? "retargeted" : null);
      if (state.blockedAgentActivationKey === key || refusal) {
        if (refusal) recordRefusal(refusal);
        state.blockedAgentActivationKey = key;
        stopActivationEvent(event);
      }
    }, true);
  }
  for (const eventName of ["beforeinput", "input"] as const) {
    activationTarget.addEventListener(eventName, (event) => {
      if (!state.agentInputActive || event.isTrusted !== true || !state.agentActivationKey) return;
      const path = boundedEventPath(event);
      const refusal = activationEventRefusal(event, path)
        || (activationRetargeted(path) ? "retargeted" : null);
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
    if (budget.exhausted && !inspectInputs(document)) withhold("document-too-large");
  });
  observer.observe(document, {
    attributes: true,
    attributeFilter: ["type", "name", "id", "autocomplete", "placeholder", "aria-label", "aria-labelledby"],
    attributeOldValue: true,
    childList: true,
    subtree: true,
  });
  state.privacyGuardInstalled = true;
  state.privacyObserver = observer;
}
