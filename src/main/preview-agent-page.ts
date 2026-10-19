import type { WebContents } from "electron";

import {
  installPreviewAgentPrivacyGuard,
  type PreviewAgentWithheldReason,
} from "../shared/preview-agent-privacy-guard.js";
import {
  AGENT_PAGE_ACTIVATION_BLOCKED_SCRIPT,
  AGENT_PAGE_SEMANTIC_SNAPSHOT_SCRIPT,
  agentPageLocateRefScript,
  agentPageNotInspected,
  agentPageRefHasFocusScript,
  agentPageSnapshotHasSensitiveVisualEvidence,
  MAX_SEMANTIC_SCAN_NODES,
  PRIVACY_RUNTIME,
  serializeAgentPageSnapshot,
  type AgentPageNotInspected,
} from "../shared/agent-page-scripts.js";
import { agentPageIsFrozen, evaluateInFrozenAgentPage } from "./preview-agent-boundary.js";

export { PRIVACY_RUNTIME, serializeAgentPageSnapshot, type AgentPageNotInspected };

// Electron's context-isolated preload world. This is the only world that owns
// credential identity; the untrusted page cannot read or mutate its state.
export const AGENT_BROWSER_WORLD_ID = 999;

export type AgentPageWithheldReason = "password" | PreviewAgentWithheldReason;

export interface AgentPageEvidencePrivacy {
  withheld: AgentPageWithheldReason | null;
}

export interface PreviewAgentTarget {
  found: boolean;
  blocked?: boolean;
  disabled?: boolean;
  editable?: boolean;
  sensitive?: boolean;
  role?: string;
  label?: string;
  x?: number;
  y?: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function target(value: unknown): PreviewAgentTarget {
  if (!plainObject(value) || value.found !== true) return { found: false };
  const x = typeof value.x === "number" && Number.isFinite(value.x)
    ? value.x
    : undefined;
  const y = typeof value.y === "number" && Number.isFinite(value.y)
    ? value.y
    : undefined;
  return {
    found: true,
    blocked: value.blocked === true,
    disabled: value.disabled === true,
    editable: value.editable === true,
    sensitive: value.sensitive === true,
    role: boundedString(value.role, 50),
    label: boundedString(value.label, 300),
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  };
}

async function execute(contents: WebContents, code: string): Promise<unknown> {
  if (agentPageIsFrozen(contents)) return await evaluateInFrozenAgentPage(contents, code);
  return await contents.executeJavaScriptInIsolatedWorld(
    AGENT_BROWSER_WORLD_ID,
    [{ code }],
    true,
  );
}

export async function waitForAgentPageHover(contents: WebContents): Promise<void> {
  await execute(contents, "new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
}

export async function semanticPageSnapshot(
  contents: WebContents,
  observed: readonly AgentPageNotInspected[] = [],
  extras: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return serializeAgentPageSnapshot(await readSemanticPage(contents, observed), extras);
}

async function readSemanticPage(
  contents: WebContents,
  observed: readonly AgentPageNotInspected[],
): Promise<unknown> {
  const value = await execute(contents, AGENT_PAGE_SEMANTIC_SNAPSHOT_SCRIPT);
  if (plainObject(value)) {
    value.notInspected = [...agentPageNotInspected(value.notInspected), ...observed];
  }
  return value;
}

export async function installAgentPagePrivacyGuard(contents: WebContents): Promise<void> {
  await execute(contents, `(${installPreviewAgentPrivacyGuard.toString()})(${PRIVACY_RUNTIME})`);
}

export async function agentPageHasSensitiveEvidence(contents: WebContents): Promise<boolean> {
  return (await agentPageEvidencePrivacy(contents)).withheld !== null;
}

export async function agentPageEvidencePrivacy(
  contents: WebContents,
  purpose: "capture" | "semantic" = "capture",
): Promise<AgentPageEvidencePrivacy> {
  const value = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) {
      throw new Error("The Browser privacy guard is unavailable.");
    }
    const privacy = ${PRIVACY_RUNTIME};
    const inspection = ${JSON.stringify(purpose === "semantic" ? "settle" : "observe")};
    if (inspection === "settle") privacy.settle(state);
    const inspect = (input) => privacy.inspect(state, input, inspection);
    if (typeof document.getElementsByTagName === "function") {
      let scanned = 0;
      for (const tag of ["input", "textarea"]) {
        const inputs = document.getElementsByTagName(tag);
        for (let index = 0; index < inputs.length; index += 1) {
          if (scanned++ >= ${MAX_SEMANTIC_SCAN_NODES}) {
            state.evidenceWithheld ??= "document-too-large";
            break;
          }
          inspect(inputs[index]);
        }
        if (scanned > ${MAX_SEMANTIC_SCAN_NODES}) break;
      }
    } else {
      const root = document.documentElement || document.body;
      const iterator = root && typeof document.createNodeIterator === "function"
        ? document.createNodeIterator(root, 1)
        : null;
      let scanned = 0;
      while (iterator && scanned < ${MAX_SEMANTIC_SCAN_NODES}) {
        const candidate = iterator.nextNode();
        if (!candidate) break;
        scanned += 1;
        if (["INPUT", "TEXTAREA"].includes(candidate.tagName)) inspect(candidate);
      }
      if (!iterator) state.evidenceWithheld ??= "credential-signal";
      else if (scanned >= ${MAX_SEMANTIC_SCAN_NODES} && iterator.nextNode()) {
        state.evidenceWithheld ??= "document-too-large";
      }
    }
    if (${JSON.stringify(purpose)} === "capture" && state.passwordValues.size > 0) return "password";
    return state.evidenceWithheld === "hidden-input" || state.evidenceWithheld === "document-too-large"
      || state.evidenceWithheld === "redaction-limit"
      ? state.evidenceWithheld
      : state.evidenceWithheld ? "credential-signal" : null;
  })()`);
  return {
    withheld: value === "password" || value === "hidden-input" || value === "credential-signal"
      || value === "document-too-large" || value === "redaction-limit"
      ? value
      : value === null ? null : "credential-signal",
  };
}


export async function agentPageHasSensitiveScreenshotEvidence(
  contents: WebContents,
): Promise<boolean> {
  if (await agentPageHasSensitiveEvidence(contents)) return true;
  return agentPageSnapshotHasSensitiveVisualEvidence(await readSemanticPage(contents, []));
}

export async function setAgentPageInputGuard(
  contents: WebContents,
  active: boolean,
  expectedClickRef?: string,
): Promise<void> {
  const updated = await execute(contents, `(() => {
    const state = globalThis.__inertiaAgentBrowser;
    if (state?.privacyGuardInstalled !== true) return false;
    state.agentActivationKey = undefined;
    state.agentActivationTarget = undefined;
    state.blockedAgentActivationKey = undefined;
    state.expectedAgentClickRef = ${active && expectedClickRef ? JSON.stringify(expectedClickRef) : "undefined"};
    state.agentInputRefused = undefined;
    state.agentInputActive = ${active ? "true" : "false"};
    return true;
  })()`);
  if (updated !== true) throw new Error("The Browser privacy guard is unavailable.");
}

export type AgentPageInputRefusal = "disabled" | "file" | "nested" | "retargeted";

export async function agentPageInputRefusal(
  contents: WebContents,
): Promise<AgentPageInputRefusal | null> {
  const value = await execute(contents, `(() => {
    const value = globalThis.__inertiaAgentBrowser?.agentInputRefused;
    return ["disabled", "file", "nested", "retargeted"].includes(value) ? value : null;
  })()`);
  return value === "disabled" || value === "file" || value === "nested" || value === "retargeted"
    ? value
    : null;
}

export async function locateAgentPageRef(
  contents: WebContents,
  ref: string,
  focus = false,
  replace = false,
): Promise<PreviewAgentTarget> {
  const value = await execute(contents, agentPageLocateRefScript(ref, focus, replace));
  return target(value);
}

export async function agentPageRefHasFocus(
  contents: WebContents,
  ref: string,
): Promise<boolean> {
  const value = await execute(contents, agentPageRefHasFocusScript(ref));
  return value === true;
}

export async function agentPageActivationBlocked(
  contents: WebContents,
): Promise<"disabled" | "file" | "nested" | null> {
  const value = await execute(contents, AGENT_PAGE_ACTIVATION_BLOCKED_SCRIPT);
  return value === "file" || value === "disabled" || value === "nested" ? value : null;
}

/**
 * A press action has no semantic ref to re-resolve after its keydown phase.
 * Keep that phase bound to the exact focused DOM target captured by the
 * privacy guard instead. A missing or changed target is deliberately unsafe:
 * subsequent key phases must not be delivered to a different control.
 */
export async function agentPageActivationTargetStillFocused(
  contents: WebContents,
): Promise<boolean> {
  const value = await execute(contents, `(() => {
    const target = globalThis.__inertiaAgentBrowser?.agentActivationTarget;
    if (!(target instanceof Element) || !target.isConnected) return false;
    let active = document.activeElement;
    let depth = 0;
    while (active?.shadowRoot?.activeElement && depth < ${MAX_SEMANTIC_SCAN_NODES}) {
      active = active.shadowRoot.activeElement;
      depth += 1;
    }
    if (active?.shadowRoot?.activeElement) return false;
    return active === target;
  })()`);
  return value === true;
}

export async function showAgentPageCursor(
  contents: WebContents,
  x: number,
  y: number,
  label: string,
): Promise<void> {
  await execute(contents, `(() => {
    const id = "__inertia_agent_cursor";
    let cursor = document.getElementById(id);
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = id;
      Object.assign(cursor.style, {
        position: "fixed", pointerEvents: "none", zIndex: "2147483647",
        display: "flex", alignItems: "center", gap: "7px",
        transform: "translate(-8px, -8px)", transition: "left 160ms ease, top 160ms ease",
        font: "600 12px/1.2 -apple-system, BlinkMacSystemFont, sans-serif",
        color: "white", filter: "drop-shadow(0 3px 8px rgba(0,0,0,.5))",
      });
      const dot = document.createElement("span");
      Object.assign(dot.style, {
        width: "16px", height: "16px", borderRadius: "999px",
        background: "#7567ff", border: "2px solid rgba(255,255,255,.95)",
        boxSizing: "border-box", boxShadow: "0 0 0 4px rgba(117,103,255,.22)",
        flex: "0 0 auto",
      });
      const copy = document.createElement("span");
      copy.dataset.inertiaAgentCursorLabel = "true";
      Object.assign(copy.style, {
        padding: "5px 8px", borderRadius: "8px",
        background: "rgba(30,28,42,.92)", border: "1px solid rgba(255,255,255,.14)",
        maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      });
      cursor.append(dot, copy);
      document.documentElement.append(cursor);
    }
    cursor.style.left = ${JSON.stringify(`${Math.round(x)}px`)};
    cursor.style.top = ${JSON.stringify(`${Math.round(y)}px`)};
    const copy = cursor.querySelector("[data-inertia-agent-cursor-label]");
    if (copy) copy.textContent = ${JSON.stringify(label.slice(0, 300))};
    cursor.animate(
      [{ opacity: .35, transform: "translate(-8px,-8px) scale(.82)" }, { opacity: 1, transform: "translate(-8px,-8px) scale(1)" }],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  })()`);
}
