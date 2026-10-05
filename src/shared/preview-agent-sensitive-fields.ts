interface SensitivePageState {
  passwordNodes: WeakSet<object>;
  passwordValues: Set<string>;
  settledValues?: Set<string>;
  fieldValues?: WeakMap<object, string>;
  mirrorValues?: WeakMap<object, string>;
  typedPrefixes?: Array<{ field: object; prefix: string }>;
  redactionForms?: Map<string, string[]>;
  evidenceWithheld?: string;
}

export type PreviewAgentSensitiveInspection = "settle" | "observe" | "type";

export const PREVIEW_AGENT_SENSITIVE_NAME_SOURCE = "(?:pass(?:word|code|phrase)s?|secrets?|credentials?"
  + "|(?:api|private|access|secret) ?keys?|authorization|one ?time ?codes?"
  + "|(?:authentication|authenticator|verification|security|mfa|2fa|recovery|backup) ?codes?"
  + "|card ?numbers?)(?![\\p{L}])"
  + "|(?<![\\p{L}\\p{N}])(?:t?otp(?: ?codes?)?|cvv|cvc|cc ?numbers?|cc ?csc|pin"
  + "|(?:api|auth|access|secret|bearer|session|csrf) ?tokens?)(?![\\p{L}])|^token$";

export const PREVIEW_AGENT_NAME_WORD_SOURCE = "\\p{Lu}+(?=\\p{Lu}\\p{Ll})|(?=[^\\s_\\-.:/])[^\\s_\\-.:/\\p{Ll}]*[^\\s_\\-.:/\\p{Lu}]*";

export function createPreviewAgentPrivacyRuntime(nameSource: string, wordSource: string) {
  const maximumValues = 256;
  const maximumValueCharacters = 4_096;
  const maximumEncodedCharacters = 1_024;
  const maximumFormCharacters = 2_097_152;
  const maximumTypedPrefixes = 1_024;
  const minimumSubstringCharacters = 4;
  const settledSubstringCharacters = 3;
  const maximumLabelCharacters = 1_200;
  const redactionWindow = 4_096;
  const sensitiveName = new RegExp(nameSource, "u");
  const nameWords = new RegExp(wordSource, "gu");
  const nameableTypes = ["text", "search", "email", "url", "tel", "number", "password", "hidden"];
  const nameAttributes = ["id", "name", "autocomplete", "placeholder", "aria-label"];
  const opaqueLabelContent = ["TEXTAREA", "SELECT", "SCRIPT", "STYLE", "TEMPLATE"];
  const ignorable = /[\s\p{Default_Ignorable_Code_Point}]/gu;
  const wordBefore = /[\p{L}\p{N}]$/u;
  const wordAfter = /^[\p{L}\p{N}]/u;
  const projectedCharacters = new Map<number, string>();
  const caches = new WeakMap<SensitivePageState, {
    version: number;
    size: number;
    settled: number;
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
  const hasSensitiveName = (element: Element): boolean => {
    const input = element as HTMLInputElement;
    const names: unknown[] = nameAttributes.map((name) => input.getAttribute?.(name) ?? "");
    for (let index = 0; index < Math.min(input.labels?.length ?? 0, 16); index += 1) {
      names.push(labelText(input.labels![index]));
    }
    const labelledBy = input.getAttribute?.("aria-labelledby") ?? "";
    if (typeof labelledBy !== "string" || labelledBy.length > maximumLabelCharacters) return true;
    for (const id of labelledBy.trim().split(/\s+/u).slice(0, 16)) {
      if (id) names.push(labelText(input.ownerDocument?.getElementById(id)));
    }
    return names.some((name) => typeof name === "string"
      && (name.length > maximumLabelCharacters || sensitiveName.test(nameText(name))));
  };
  const isSensitiveField = (element: Element): boolean => {
    const type = fieldType(element);
    if (type === "password") return true;
    if (type !== "textarea" && !nameableTypes.includes(type)) return false;
    return hasSensitiveName(element);
  };
  const remember = (
    state: SensitivePageState,
    value: unknown,
    inspection: PreviewAgentSensitiveInspection = "observe",
  ): void => {
    if (typeof value !== "string") return;
    if (value.length > maximumValueCharacters) {
      state.evidenceWithheld ??= "redaction-limit";
      return;
    }
    if (!value) return;
    if (!state.passwordValues.has(value)) {
      if (state.passwordValues.size >= maximumValues) {
        state.evidenceWithheld ??= "redaction-limit";
        return;
      }
      state.passwordValues.add(value);
      version += 1;
    }
    if (inspection === "settle" && !state.settledValues?.has(value)) {
      (state.settledValues ??= new Set()).add(value);
      version += 1;
    }
  };
  const extendsPrefix = (state: SensitivePageState, value: string, prefix: string): boolean => (
    value !== prefix && value.startsWith(prefix) && state.settledValues?.has(prefix) !== true
  );
  const forget = (state: SensitivePageState, prefix: string): void => {
    if (state.passwordValues.delete(prefix)) version += 1;
  };
  const collapse = (state: SensitivePageState, field: object, value: string): void => {
    const fields = state.fieldValues ??= new WeakMap();
    const previous = fields.get(field);
    fields.set(field, value);
    const typed = state.typedPrefixes ??= [];
    if (previous !== undefined && previous !== "" && extendsPrefix(state, value, previous)) {
      typed.push({ field, prefix: previous });
      if (typed.length > maximumTypedPrefixes) typed.shift();
    }
    if (state.passwordValues.size < maximumValues || state.passwordValues.has(value)) return;
    for (let index = 0; index < typed.length; index += 1) {
      const candidate = typed[index]!;
      if (candidate.field !== field || !extendsPrefix(state, value, candidate.prefix)) continue;
      forget(state, candidate.prefix);
      typed.splice(index, 1);
      return;
    }
  };
  const settle = (state: SensitivePageState): void => {
    const typed = state.typedPrefixes;
    if (!typed || typed.length === 0) return;
    state.typedPrefixes = [];
    for (const { field, prefix } of typed) {
      const input = field as HTMLInputElement;
      const current = input.isConnected === false ? undefined : input.value;
      if (typeof current === "string" && extendsPrefix(state, current, prefix)) forget(state, prefix);
    }
  };
  const inspect = (
    state: SensitivePageState,
    input: HTMLInputElement,
    inspection: PreviewAgentSensitiveInspection = "observe",
    wasSensitive = false,
  ): void => {
    if (wasSensitive || isSensitiveField(input)) {
      state.passwordNodes.add(input);
      state.mirrorValues?.delete(input);
    } else {
      const basis = state.mirrorValues?.get(input);
      if (basis !== undefined && !state.passwordValues.has(basis)) {
        state.passwordNodes.delete(input);
        state.mirrorValues!.delete(input);
      }
    }
    const sensitive = state.passwordNodes.has(input);
    if (!sensitive && state.passwordValues.size === 0) return;
    const value = input.value;
    const known = typeof value === "string" && value.length <= maximumValueCharacters;
    if (!sensitive) {
      if (!(known && value.length >= minimumSubstringCharacters && state.passwordValues.has(value))) return;
      (state.mirrorValues ??= new WeakMap()).set(input, value);
    }
    state.passwordNodes.add(input);
    if (inspection === "type" && known) collapse(state, input, value);
    const memory = inspection === "settle" ? "settle" : "observe";
    remember(state, value, memory);
    remember(state, input.defaultValue, memory);
  };
  const projectCharacter = (code: number): string => {
    let piece = projectedCharacters.get(code);
    if (piece === undefined) {
      piece = String.fromCodePoint(code).normalize("NFKD").toLowerCase().replace(ignorable, "");
      projectedCharacters.set(code, piece);
    }
    return piece;
  };
  const project = (text: string, starts?: number[], ends?: number[]): string => {
    let projected = "";
    for (let index = 0; index < text.length;) {
      const code = text.codePointAt(index)!;
      const next = index + (code > 0xffff ? 2 : 1);
      const piece = code < 0x80
        ? code === 0x20 || (code >= 0x09 && code <= 0x0d) ? "" : String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 32 : code)
        : projectCharacter(code);
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
  const forms = (secret: string): string[] => {
    const raw = [secret];
    if (secret.length <= maximumEncodedCharacters) {
      raw.push(JSON.stringify(secret).slice(1, -1));
      const component = (() => {
        try { return encodeURIComponent(secret); } catch { return ""; }
      })();
      if (component) {
        const form = component.replace(/%20/gu, "+")
          .replace(/[!'()~]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        raw.push(component, encodeURI(secret), form, form.replace(/\*/gu, "%2A"), hexadecimal(component));
      }
    }
    const projected: string[] = [];
    for (const form of new Set(raw)) {
      const text = project(form);
      if (text && !projected.includes(text)) projected.push(text);
    }
    return projected;
  };
  const variants = (state: SensitivePageState) => {
    const cached = caches.get(state);
    const settled = state.settledValues?.size ?? 0;
    if (cached && cached.version === version && cached.size === state.passwordValues.size
      && cached.settled === settled) return cached.variants;
    const stored = state.redactionForms ??= new Map();
    for (const secret of stored.keys()) if (!state.passwordValues.has(secret)) stored.delete(secret);
    const found = new Map<string, boolean>();
    let characters = 0;
    for (const secret of state.passwordValues) {
      let projected = stored.get(secret);
      if (!projected) {
        projected = forms(secret);
        stored.set(secret, projected);
      }
      const literal = projected[0] ?? "";
      if (!literal) continue;
      const short = literal.length < minimumSubstringCharacters;
      const token = short && !(literal.length === settledSubstringCharacters && state.settledValues?.has(secret) === true);
      for (const text of projected) {
        if (short && text.length !== literal.length) continue;
        characters += text.length;
        if (characters > maximumFormCharacters) {
          state.evidenceWithheld ??= "redaction-limit";
          break;
        }
        found.set(text, token && found.get(text) !== false);
      }
    }
    const list = [...found].map(([text, token]) => ({ text, token }))
      .sort((left, right) => right.text.length - left.text.length);
    caches.set(state, { version, size: state.passwordValues.size, settled, variants: list });
    return list;
  };
  const unsafeTail = (projected: string, list: Array<{ text: string }>): number => {
    let start = projected.length;
    for (const { text } of list) {
      const first = text[0]!;
      let at = projected.indexOf(first, Math.max(0, projected.length - text.length + 1));
      while (at !== -1 && at < start) {
        if (text.startsWith(projected.slice(at))) {
          start = at;
          break;
        }
        at = projected.indexOf(first, at + 1);
      }
    }
    return start;
  };
  const clip = (state: SensitivePageState, value: string): string => {
    const list = variants(state);
    if (list.length === 0) return value;
    const starts: number[] = [];
    const projected = project(value, starts);
    const start = unsafeTail(projected, list);
    return start >= projected.length ? value : value.slice(0, starts[start]);
  };
  const redact = (
    state: SensitivePageState,
    value: unknown,
    maximum: number,
    truncated = false,
    sourceLimit = 0,
  ): string => {
    const raw = String(value ?? "");
    const list = variants(state);
    const finish = (text: string): string => text.replace(/\s+/gu, " ").trim().slice(0, maximum);
    if (list.length === 0) {
      return finish(raw.slice(0, Math.max(sourceLimit, maximumLabelCharacters, maximum * 4)));
    }
    const source = raw.slice(0, Math.max(sourceLimit, maximum + redactionWindow + list[0]!.text.length));
    const starts: number[] = [];
    const ends: number[] = [];
    const projected = project(source, starts, ends);
    const tail = truncated || raw.length > source.length ? unsafeTail(projected, list) : projected.length;
    const limit = tail >= projected.length ? source.length : starts[tail]!;
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
  return { isSensitiveField, hasSensitiveName, remember, inspect, settle, redact, clip };
}
