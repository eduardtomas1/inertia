interface SensitivePageState {
  passwordNodes: WeakSet<object>;
  passwordValues: Set<string>;
  settledValues?: Set<string>;
  evictedValues?: Set<string>;
  fieldValues?: WeakMap<object, string>;
  evidenceWithheld?: string;
}

export type PreviewAgentSensitiveInspection = "settle" | "observe" | "type";

export const PREVIEW_AGENT_SENSITIVE_NAME_SOURCE = "(?<![\\p{L}\\p{N}])(?:pass(?:word|code|phrase)s?|secrets?|credentials?"
  + "|(?:api|private) ?keys?|authorization|one ?time ?codes?"
  + "|(?:authentication|authenticator|verification|security|mfa|2fa|recovery|backup) ?codes?"
  + "|t?otp|cvv|cvc|(?:card|cc) ?numbers?|cc ?csc|pin"
  + "|(?:api|auth|access|secret|bearer|session|csrf) ?tokens?)(?![\\p{L}])|^token$";

export const PREVIEW_AGENT_NAME_WORD_SOURCE = "\\p{Lu}+(?=\\p{Lu}\\p{Ll})|(?=[^\\s_\\-.:/])[^\\s_\\-.:/\\p{Ll}]*[^\\s_\\-.:/\\p{Lu}]*";

export function createPreviewAgentPrivacyRuntime(nameSource: string, wordSource: string) {
  const maximumValues = 256;
  const maximumValueCharacters = 4_096;
  const minimumSubstringCharacters = 4;
  const maximumLabelCharacters = 1_200;
  const redactionWindow = 4_096;
  const sensitiveName = new RegExp(nameSource, "u");
  const nameWords = new RegExp(wordSource, "gu");
  const nameableTypes = ["text", "search", "email", "url", "tel", "number", "password", "hidden"];
  const nameAttributes = ["id", "name", "autocomplete", "placeholder", "aria-label"];
  const opaqueLabelContent = ["TEXTAREA", "SELECT", "SCRIPT", "STYLE", "TEMPLATE"];
  const ignorable = /[\s­​-‍⁠﻿]/gu;
  const wordBefore = /[\p{L}\p{N}]$/u;
  const wordAfter = /^[\p{L}\p{N}]/u;
  const caches = new WeakMap<SensitivePageState, {
    version: number;
    size: number;
    settled: number;
    reach: number;
    variants: Array<{ text: string; token: boolean }>;
  }>();
  let version = 0;
  const nameText = (value: string): string => (value.match(nameWords) ?? []).join(" ").toLowerCase();
  const labelText = (element: Element | null | undefined): string => {
    let text = "";
    let node = element?.firstChild ?? null;
    let visited = 0;
    while (node) {
      if (++visited > 128) return "password";
      if (node.nodeType === 3) text += (node.nodeValue ?? "").slice(0, maximumLabelCharacters + 1 - text.length);
      if (text.length > maximumLabelCharacters) return "password";
      if (node.firstChild && !opaqueLabelContent.includes((node as Element).tagName)) {
        node = node.firstChild;
        continue;
      }
      while (node && node !== element && !node.nextSibling) node = node.parentNode as ChildNode | null;
      if (!node || node === element) break;
      node = node.nextSibling;
    }
    return text;
  };
  const fieldType = (element: Element): string => {
    if (element.tagName === "TEXTAREA") return "textarea";
    if (element.tagName !== "INPUT") return "";
    const type = (element as HTMLInputElement).type;
    return typeof type === "string" && type.length <= 20 ? type.trim().toLowerCase() || "text" : "text";
  };
  const isSensitiveField = (element: Element): boolean => {
    const type = fieldType(element);
    if (type === "password") return true;
    if (type !== "textarea" && !nameableTypes.includes(type)) return false;
    const input = element as HTMLInputElement;
    const names: unknown[] = nameAttributes.map((name) => input.getAttribute?.(name) ?? "");
    for (let index = 0; index < Math.min(input.labels?.length ?? 0, 16); index += 1) {
      names.push(labelText(input.labels![index]));
    }
    const labelledBy = input.getAttribute?.("aria-labelledby") ?? "";
    if (labelledBy.length > maximumLabelCharacters) return true;
    for (const id of labelledBy.trim().split(/\s+/u).slice(0, 16)) {
      if (id) names.push(labelText(input.ownerDocument?.getElementById(id)));
    }
    return names.some((name) => typeof name === "string"
      && (name.length > maximumLabelCharacters || sensitiveName.test(nameText(name))));
  };
  const remember = (
    state: SensitivePageState,
    value: unknown,
    memory: PreviewAgentSensitiveInspection | "signal" = "observe",
  ): void => {
    if (typeof value !== "string") return;
    if (value.length > maximumValueCharacters) {
      state.evidenceWithheld ??= "redaction-limit";
      return;
    }
    if (!value || (memory === "signal" && state.evictedValues?.has(value))) return;
    state.evictedValues?.delete(value);
    if (!state.passwordValues.has(value)) {
      if (state.passwordValues.size >= maximumValues) {
        state.evidenceWithheld ??= "redaction-limit";
        return;
      }
      state.passwordValues.add(value);
      version += 1;
    }
    if (memory === "settle" && !state.settledValues?.has(value)) {
      (state.settledValues ??= new Set()).add(value);
      version += 1;
    }
  };
  const collapse = (state: SensitivePageState, field: object, value: string): void => {
    const fields = state.fieldValues ??= new WeakMap();
    const previous = fields.get(field);
    fields.set(field, value);
    if (previous === undefined || previous === value || !value.startsWith(previous)
      || state.settledValues?.has(previous) || !state.passwordValues.delete(previous)) return;
    version += 1;
    const evicted = state.evictedValues ??= new Set();
    evicted.add(previous);
    if (evicted.size > maximumValues) evicted.delete(evicted.values().next().value as string);
  };
  const inspect = (
    state: SensitivePageState,
    input: HTMLInputElement,
    inspection: PreviewAgentSensitiveInspection = "observe",
  ): void => {
    const sensitive = state.passwordNodes.has(input) || isSensitiveField(input);
    if (!sensitive && state.passwordValues.size === 0) return;
    const value = input.value;
    const known = typeof value === "string" && value.length <= maximumValueCharacters;
    if (!sensitive && !(known && value.length >= minimumSubstringCharacters
      && state.passwordValues.has(value))) return;
    state.passwordNodes.add(input);
    if (inspection === "type" && known) collapse(state, input, value);
    remember(state, value, inspection === "settle" ? "settle" : "observe");
    remember(state, input.defaultValue, inspection === "settle" ? "settle" : "signal");
  };
  const project = (text: string, starts?: number[], ends?: number[]): string => {
    let projected = "";
    for (let index = 0; index < text.length;) {
      const code = text.codePointAt(index)!;
      const next = index + (code > 0xffff ? 2 : 1);
      const piece = code < 0x80
        ? code === 0x20 || (code >= 0x09 && code <= 0x0d) ? "" : String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 32 : code)
        : String.fromCodePoint(code).normalize("NFKD").toLowerCase().replace(ignorable, "");
      for (let offset = 0; offset < piece.length; offset += 1) {
        starts?.push(index);
        ends?.push(next);
      }
      projected += piece;
      index = next;
    }
    return projected;
  };
  const hexadecimal = (component: string): string => {
    let text = "";
    for (let index = 0; index < component.length; index += 1) {
      if (component[index] === "%") {
        text += component.slice(index + 1, index + 3);
        index += 2;
      } else text += component.charCodeAt(index).toString(16).padStart(2, "0");
    }
    return text;
  };
  const variants = (state: SensitivePageState) => {
    const cached = caches.get(state);
    const settled = state.settledValues?.size ?? 0;
    if (cached && cached.version === version && cached.size === state.passwordValues.size
      && cached.settled === settled) return cached;
    const found = new Map<string, boolean>();
    for (const secret of state.passwordValues) {
      const literal = project(secret);
      if (!literal) continue;
      const short = literal.length < minimumSubstringCharacters;
      const token = short && state.settledValues?.has(secret) !== true;
      const forms = [secret, JSON.stringify(secret).slice(1, -1)];
      const component = (() => {
        try { return encodeURIComponent(secret); } catch { return ""; }
      })();
      if (component) {
        const form = component.replace(/%20/gu, "+")
          .replace(/[!'()~]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        forms.push(component, encodeURI(secret), form, form.replace(/\*/gu, "%2A"));
        if (!short) forms.push(hexadecimal(component));
      }
      for (const form of forms) {
        const projected = project(form);
        if (projected) found.set(projected, token && found.get(projected) !== false);
      }
    }
    const list = [...found].map(([text, token]) => ({ text, token }))
      .sort((left, right) => right.text.length - left.text.length);
    const entry = {
      version, size: state.passwordValues.size, settled, reach: list[0]?.text.length ?? 0, variants: list,
    };
    caches.set(state, entry);
    return entry;
  };
  const safeLength = (projectedLength: number, starts: number[], reach: number): number => {
    const first = projectedLength - reach + 1;
    return first <= 0 ? 0 : first >= projectedLength ? Number.MAX_SAFE_INTEGER : starts[first]!;
  };
  const clip = (state: SensitivePageState, value: string): string => {
    const { reach } = variants(state);
    if (reach === 0) return value;
    const starts: number[] = [];
    const projected = project(value, starts);
    return value.slice(0, safeLength(projected.length, starts, reach));
  };
  const redact = (state: SensitivePageState, value: unknown, maximum: number, truncated = false): string => {
    const raw = String(value ?? "");
    const { reach, variants: list } = variants(state);
    const source = raw.slice(0, maximum + redactionWindow + reach);
    const finish = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, maximum);
    if (list.length === 0) return finish(raw.slice(0, Math.max(maximumLabelCharacters, maximum * 4)));
    const starts: number[] = [];
    const ends: number[] = [];
    const projected = project(source, starts, ends);
    const limit = truncated || raw.length > source.length
      ? safeLength(projected.length, starts, reach)
      : source.length;
    const covered = new Uint8Array(source.length);
    for (const { text, token } of list) {
      let marked = 0;
      for (let at = projected.indexOf(text); at !== -1; at = projected.indexOf(text, at + 1)) {
        const start = starts[at]!;
        const end = ends[at + text.length - 1]!;
        if (token && (wordBefore.test(source.slice(Math.max(0, start - 2), start))
          || wordAfter.test(source.slice(end, end + 2)))) continue;
        for (let index = Math.max(start, marked); index < end; index += 1) covered[index] = 1;
        marked = Math.max(marked, end);
      }
    }
    let output = "";
    let from = 0;
    for (let index = 0; index < source.length && index < limit; index += 1) {
      if (covered[index] !== 1) continue;
      output += `${source.slice(from, index)}[redacted]`;
      while (index < source.length && covered[index] === 1) index += 1;
      from = index;
    }
    output += source.slice(from, Math.max(from, Math.min(limit, source.length)));
    return finish(output);
  };
  return { isSensitiveField, remember, inspect, redact, clip };
}
