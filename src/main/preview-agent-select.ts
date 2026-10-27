import type { WebContents } from "electron";

import { agentPageIsFrozen, evaluateInFrozenAgentPage } from "./preview-agent-boundary.js";
import { AGENT_BROWSER_WORLD_ID, PRIVACY_RUNTIME } from "./preview-agent-page.js";

const MAX_SELECT_OPTIONS = 4_000;
const MAX_LISTED_OPTIONS = 20;
const MAX_LISTED_LABEL_CHARS = 30;
const MAX_CHOSEN_TEXT_CHARS = 200;
const MAX_CASE_FOLD_CHARS = 1_000;

export type AgentPageSelection =
  | { outcome: "selected"; value: string; label: string }
  | { outcome: "not-found"; options: string[]; total: number }
  | { outcome: "stale" | "not-select" | "nested" | "multiple" | "disabled" | "option-disabled" | "too-large" };

async function execute(contents: WebContents, code: string): Promise<unknown> {
  if (agentPageIsFrozen(contents)) return await evaluateInFrozenAgentPage(contents, code);
  return await contents.executeJavaScriptInIsolatedWorld(AGENT_BROWSER_WORLD_ID, [{ code }], true);
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function selection(value: unknown): AgentPageSelection {
  if (typeof value !== "object" || value === null) return { outcome: "stale" };
  const result = value as Record<string, unknown>;
  switch (result.outcome) {
    case "selected":
      return {
        outcome: "selected",
        value: boundedText(result.value, MAX_CHOSEN_TEXT_CHARS),
        label: boundedText(result.label, MAX_CHOSEN_TEXT_CHARS),
      };
    case "not-found":
      return {
        outcome: "not-found",
        options: Array.isArray(result.options)
          ? result.options.slice(0, MAX_LISTED_OPTIONS).map((option) => boundedText(option, MAX_LISTED_LABEL_CHARS))
          : [],
        total: typeof result.total === "number" && Number.isSafeInteger(result.total) && result.total >= 0
          ? result.total
          : 0,
      };
    case "not-select":
    case "nested":
    case "multiple":
    case "disabled":
    case "option-disabled":
    case "too-large":
      return { outcome: result.outcome };
    default:
      return { outcome: "stale" };
  }
}

export async function selectAgentPageOption(
  contents: WebContents,
  ref: string,
  wanted: string,
): Promise<AgentPageSelection> {
  const value = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) {
      throw new Error("The Browser privacy guard is unavailable.");
    }
    const element = state.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return { outcome: "stale" };
    if (element.tagName !== "SELECT") return { outcome: "not-select" };
    if (element.ownerDocument !== document || element.getRootNode?.() !== document) return { outcome: "nested" };
    if (element.multiple === true) return { outcome: "multiple" };
    const ariaDisabled = (candidate) => {
      const value = candidate?.getAttribute?.("aria-disabled");
      return typeof value === "string" && value.length <= 10 && value.trim().toLowerCase() === "true";
    };
    let current = element;
    let depth = 0;
    while (current && depth < ${MAX_SELECT_OPTIONS}) {
      if (ariaDisabled(current)) return { outcome: "disabled" };
      current = current.parentElement;
      depth += 1;
    }
    if (current || element.disabled === true || element.matches?.(":disabled")) return { outcome: "disabled" };
    const options = element.options;
    const total = typeof options?.length === "number" ? options.length : 0;
    if (total > ${MAX_SELECT_OPTIONS}) return { outcome: "too-large" };
    const wanted = ${JSON.stringify(wanted)};
    const folded = wanted.toLowerCase();
    const text = (value) => typeof value === "string" ? value : "";
    const fold = (value) => value.length <= ${MAX_CASE_FOLD_CHARS} ? value.toLowerCase() : null;
    const matchers = [
      (option) => text(option.value) === wanted,
      (option) => text(option.label) === wanted,
      (option) => fold(text(option.value)) === folded,
      (option) => fold(text(option.label)) === folded,
    ];
    let index = -1;
    for (const matches of matchers) {
      for (let candidate = 0; candidate < total && index < 0; candidate += 1) {
        if (matches(options[candidate])) index = candidate;
      }
      if (index >= 0) break;
    }
    const privacy = ${PRIVACY_RUNTIME};
    const hidden = Boolean(state.evidenceWithheld) || state.passwordNodes?.has?.(element) === true;
    const redact = (value, maximum) => hidden ? "[redacted]" : privacy.redact(state, value, maximum);
    if (index < 0) {
      const listed = [];
      for (let candidate = 0; candidate < total && listed.length < ${MAX_LISTED_OPTIONS} && !hidden; candidate += 1) {
        listed.push(redact(text(options[candidate].label), ${MAX_LISTED_LABEL_CHARS}));
      }
      return { outcome: "not-found", options: listed, total };
    }
    const option = options[index];
    if (option.disabled === true || (option.parentElement?.tagName === "OPTGROUP" && option.parentElement.disabled === true)) {
      return { outcome: "option-disabled" };
    }
    element.selectedIndex = index;
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      outcome: "selected",
      value: redact(text(option.value), ${MAX_CHOSEN_TEXT_CHARS}),
      label: redact(text(option.label), ${MAX_CHOSEN_TEXT_CHARS}),
    };
  })()`);
  return selection(value);
}
