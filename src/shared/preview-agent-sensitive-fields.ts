interface SensitivePageState {
  passwordNodes: WeakSet<object>;
  passwordValues: Set<string>;
  evidenceWithheld?: string;
}

/** Self-contained: serialized into the context-isolated Browser world. */
export function createPreviewAgentPrivacyRuntime() {
  const maximumValues = 256;
  const maximumValueCharacters = 4_096;
  const patterns = new WeakMap<SensitivePageState, { count: number; expression: RegExp | null }>();
  const normalize = (value: string): string => value.replace(/\s+/gu, " ").trim();
  const sensitiveName = /password|passcode|passphrase|token|secret|credential|api[\s_-]?key|private[\s_-]?key|authorization|one[\s_-]?time[\s_-]?code|(?:authentication|authenticator|verification|security|mfa|2fa)[\s_-]*code|cc-number|cc-csc/iu;
  const labelText = (element: Element | null | undefined): string => {
    let text = "";
    let node = element?.firstChild ?? null;
    let visited = 0;
    while (node) {
      // Oversized labels are classified conservatively, without aggregating
      // an unbounded textContent string from a page-controlled subtree.
      if (++visited > 128) return "password";
      if (node.nodeType === 3) text += (node.nodeValue ?? "").slice(0, 1_201 - text.length);
      if (text.length > 1_200) return "password";
      if (node.firstChild) { node = node.firstChild; continue; }
      while (node && node !== element && !node.nextSibling) node = node.parentNode as ChildNode | null;
      if (!node || node === element) break;
      node = node.nextSibling;
    }
    return text;
  };
  const isSensitiveField = (element: Element): boolean => {
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return false;
    const input = element as HTMLInputElement;
    if (input.type === "password") return true;
    const names = ["id", "name", "autocomplete", "placeholder", "aria-label"]
      .map((name) => input.getAttribute?.(name) ?? "");
    for (let index = 0; index < Math.min(input.labels?.length ?? 0, 16); index += 1) {
      names.push(labelText(input.labels![index]));
    }
    const labelledBy = input.getAttribute?.("aria-labelledby") ?? "";
    if (labelledBy.length > 1_200) return true;
    for (const id of labelledBy.trim().split(/\s+/u).slice(0, 16)) {
      if (id) names.push(labelText(input.ownerDocument?.getElementById(id)));
    }
    return names.some((name) => name.length > 1_200 || sensitiveName.test(name));
  };
  const remember = (state: SensitivePageState, value: unknown): void => {
    if (typeof value !== "string") return;
    if (value.length > maximumValueCharacters) {
      state.evidenceWithheld ??= "redaction-limit";
      return;
    }
    if (!value || state.passwordValues.has(value)) return;
    // Never evict an earlier password while its document can still mirror it.
    if (state.passwordValues.size >= maximumValues) {
      state.evidenceWithheld ??= "redaction-limit";
      return;
    }
    state.passwordValues.add(value);
  };
  const inspect = (state: SensitivePageState, input: HTMLInputElement): void => {
    const sensitive = state.passwordNodes.has(input) || isSensitiveField(input);
    if (!sensitive && state.passwordValues.size === 0) return;
    const value = input.value;
    if (sensitive || (typeof value === "string" && value.length <= maximumValueCharacters
      && state.passwordValues.has(value))) {
      state.passwordNodes.add(input);
      remember(state, value);
      remember(state, input.defaultValue);
    }
  };
  const redact = (state: SensitivePageState, value: unknown, maximum: number): string => {
    const source = normalize(String(value ?? "").slice(0, Math.max(1_200, maximum * 4)));
    const cached = patterns.get(state);
    if (cached?.count === state.passwordValues.size) {
      return (cached.expression ? source.replace(cached.expression, "[redacted]") : source).slice(0, maximum);
    }
    const values = [...state.passwordValues]
      .flatMap((secret) => {
        const normalized = normalize(secret);
        try { return [normalized, encodeURIComponent(secret), encodeURIComponent(normalized)]; }
        catch { return [normalized]; } // A DOM string may contain an unpaired surrogate.
      })
      .sort((left, right) => right.length - left.length);
    // Replace in one pass so a short secret cannot corrupt a redaction marker.
    const escape = (secret: string): string => secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const alternatives = [...new Set(values)].filter(Boolean).map((secret) => {
      const escaped = escape(secret);
      // Native typing observes intermediate characters too. Mask short values
      // as whole tokens, keeping labels such as "Email" readable after "a".
      return secret.length < 4 ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped;
    });
    const expression = alternatives.length > 0 ? new RegExp(alternatives.join("|"), "gu") : null;
    patterns.set(state, { count: state.passwordValues.size, expression });
    const text = expression ? source.replace(expression, "[redacted]") : source;
    return text.slice(0, maximum);
  };
  return { isSensitiveField, remember, inspect, redact };
}
