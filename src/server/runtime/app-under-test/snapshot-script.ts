import {
  AGENT_PAGE_ACTIVATION_BLOCKED_SCRIPT,
  AGENT_PAGE_SEMANTIC_SNAPSHOT_SCRIPT,
  agentPageLocateRefScript,
  agentPageRefHasFocusScript,
  MAX_SEMANTIC_SCAN_NODES,
  PRIVACY_RUNTIME,
} from "../../../shared/agent-page-scripts";
import { MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS } from "../../../shared/preview-agent-dialogs";

/**
 * Expressions the App transport evaluates in its own CDP isolated world (one
 * per main-frame document, created with `Page.createIsolatedWorld`). The
 * semantic snapshot and ref lookup are the Browser's own scripts, so refs,
 * roles, names, redaction and hit testing follow the same rules. Every
 * expression returns a JSON string built with the isolated world's own
 * `JSON`, which the page cannot replace.
 *
 * Unlike the Browser, no main-world privacy guard runs before the app's
 * scripts: values are learned from sensitive fields when Inertia scans or
 * types into them, never by watching value accessors.
 */

export const APP_ISOLATED_WORLD_NAME = "inertia-app-under-test";

const json = (expression: string): string => `JSON.stringify(${expression})`;
const STATE = "globalThis.__inertiaAgentBrowser";
const DEEP_ACTIVE = `(() => {
      let active = document.activeElement;
      let depth = 0;
      while (active?.shadowRoot?.activeElement && depth < ${MAX_SEMANTIC_SCAN_NODES}) {
        active = active.shadowRoot.activeElement;
        depth += 1;
      }
      return active?.shadowRoot?.activeElement ? null : active;
    })()`;

/** JSON characters of newly found secret values returned by one read. */
export const MAX_APP_REPORTED_SECRET_CHARS = 128 * 1024;

/**
 * The guarded snapshot value plus the document's privacy state. `remember`
 * is internal: it hands the runtime the secret values this document's scans
 * found (or the agent typed) that it has not reported yet, so the runtime can
 * hide them from log lines and window titles. The runtime strips it before
 * anything reaches a model.
 */
function snapshotExpression(scan: string): string {
  return json(`(() => {
  const value = ${scan};
  const state = ${STATE};
  const remember = [];
  if (state?.passwordValues) {
    const reported = state.appReported ??= new Set();
    let budget = ${MAX_APP_REPORTED_SECRET_CHARS};
    for (const secret of state.passwordValues) {
      if (typeof secret !== "string" || reported.has(secret)) continue;
      const size = JSON.stringify(secret).length;
      if (size > budget) break;
      budget -= size;
      reported.add(secret);
      remember.push(secret);
    }
  }
  return {
    value,
    withheld: typeof state?.evidenceWithheld === "string" ? state.evidenceWithheld : null,
    remembered: state?.passwordValues?.size ?? 0,
    readyState: String(document.readyState),
    remember,
  };
})()`);
}

export const APP_SNAPSHOT_EXPRESSION = snapshotExpression(AGENT_PAGE_SEMANTIC_SNAPSHOT_SCRIPT);

/**
 * Runs `scan` against a scratch overlay of the document's state: privacy
 * memory is shared, but refs, the node map and the ref counter are the
 * scratch's own and are discarded, so a read the agent never sees mints no
 * ref and leaves the latest snapshot's refs in place. Anything else the scan
 * records (withheld evidence, observed frames) is copied back.
 */
export function appScratchRefsScript(scan: string): string {
  return `(() => {
  const owner = globalThis;
  const base = owner.__inertiaAgentBrowser ??= {
    refs: new Map(), nodes: new WeakMap(), passwordNodes: new WeakSet(), passwordValues: new Set(), next: 1,
  };
  const scratch = Object.create(base);
  scratch.refs = new Map();
  scratch.nodes = new WeakMap();
  scratch.next = 1;
  owner.__inertiaAgentBrowser = scratch;
  try {
    return ${scan};
  } finally {
    owner.__inertiaAgentBrowser = base;
    for (const key of Object.keys(scratch)) {
      if (key !== "refs" && key !== "nodes" && key !== "next") base[key] = scratch[key];
    }
  }
})()`;
}

/** A wait poll's read: the snapshot value and privacy state without minting or clearing refs. */
export const APP_WAIT_READ_EXPRESSION = snapshotExpression(appScratchRefsScript(AGENT_PAGE_SEMANTIC_SNAPSHOT_SCRIPT));

export function appLocateExpression(ref: string, focus = false, replace = false): string {
  return json(agentPageLocateRefScript(ref, focus, replace));
}

export function appRefHasFocusExpression(ref: string): string {
  return json(agentPageRefHasFocusScript(ref));
}

function describeExpression(elementSource: string): string {
  return json(`(() => {
    const state = ${STATE} ?? { refs: new Map(), passwordNodes: new WeakSet(), passwordValues: new Set() };
    const element = ${elementSource};
    if (!element || !element.isConnected) return { found: false };
    const privacy = ${PRIVACY_RUNTIME};
    const attribute = (name) => {
      const value = element.getAttribute?.(name);
      return typeof value === "string" ? value.slice(0, 600) : "";
    };
    const sensitive = Boolean(state.evidenceWithheld) || state.passwordNodes?.has(element) === true
      || privacy.isSensitiveField(element);
    const text = String(element.textContent ?? "").slice(0, 600);
    const role = attribute("role").trim().toLowerCase().slice(0, 50)
      || ({ A: "link", BUTTON: "button", INPUT: "input", SELECT: "select", TEXTAREA: "textbox", SUMMARY: "button" })[element.tagName]
      || String(element.tagName).toLowerCase().slice(0, 50);
    const label = sensitive
      ? "Sensitive field"
      : privacy.redact(state, attribute("aria-label") || text || attribute("title") || attribute("placeholder") || "app control", 300);
    return { found: true, role, label, sensitive };
  })()`);
}

/** Role, label and sensitivity of a ref wherever it is, without scrolling. */
export function appDescribeExpression(ref: string): string {
  return describeExpression(`state.refs?.get(${JSON.stringify(ref)})`);
}

/**
 * Role, label and sensitivity of the control a key press would reach;
 * `found: false` when focus is on the document itself.
 */
export const APP_FOCUSED_DESCRIBE_EXPRESSION = describeExpression(`(() => {
      const active = ${DEEP_ACTIVE};
      return active && active !== document.body && active !== document.documentElement ? active : null;
    })()`);

const VIEWPORT = "{ width: innerWidth, height: innerHeight, scrollX, scrollY }";

export function appRefOutsideViewportExpression(ref: string): string {
  return json(`(() => {
    const element = ${STATE}?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth;
  })()`);
}

export function appScrollRefExpression(ref: string): string {
  return json(`(() => {
    const element = ${STATE}?.refs?.get(${JSON.stringify(ref)});
    if (!element || !element.isConnected) return { found: false };
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    return { found: true, viewport: ${VIEWPORT} };
  })()`);
}

export const APP_VIEWPORT_EXPRESSION = json(`(${VIEWPORT})`);

export const APP_READY_STATE_EXPRESSION = json("String(document.readyState)");

/** Resolves after one animation frame, or 100 ms when the window does not paint. */
export const APP_NEXT_FRAME_EXPRESSION = `new Promise((resolve) => {
  const done = () => resolve("true");
  const timer = setTimeout(done, 100);
  requestAnimationFrame(() => { clearTimeout(timer); done(); });
})`;

/**
 * When the ref is a password or credential-named field, remembers what the
 * agent typed and the field's resulting value so later snapshots redact
 * them. Returns true only for such a field.
 */
export function appRememberTypedExpression(ref: string, text: string): string {
  return json(`(() => {
    const state = ${STATE};
    const element = state?.refs?.get(${JSON.stringify(ref)});
    if (!state || !element || !element.isConnected) return false;
    const privacy = ${PRIVACY_RUNTIME};
    const role = element.getAttribute?.("role");
    const sensitive = state.passwordNodes?.has(element) === true
      || privacy.isSensitiveField(element)
      || ((element.isContentEditable === true
        || (typeof role === "string" && role.length <= 50 && role.trim().toLowerCase() === "textbox"))
        && privacy.hasSensitiveName(element));
    if (!sensitive) return false;
    if (["INPUT", "TEXTAREA"].includes(element.tagName)) privacy.inspect(state, element, "type", true);
    privacy.remember(state, ${JSON.stringify(text)});
    return true;
  })()`);
}

/** Before an activation key: the Browser's refusal check, then pins the focused control. */
export const APP_PRESS_BEGIN_EXPRESSION = json(`(() => {
  const blocked = ${AGENT_PAGE_ACTIVATION_BLOCKED_SCRIPT};
  const state = ${STATE} ??= { refs: new Map(), nodes: new WeakMap(), passwordNodes: new WeakSet(), passwordValues: new Set(), next: 1 };
  state.appPressTarget = blocked ? undefined : ${DEEP_ACTIVE};
  return blocked;
})()`);

/** After keydown: null when the same control is still focused and may be activated. */
export const APP_PRESS_CONTINUE_EXPRESSION = json(`(() => {
  const state = ${STATE};
  const target = state?.appPressTarget;
  if (state) state.appPressTarget = undefined;
  const blocked = ${AGENT_PAGE_ACTIVATION_BLOCKED_SCRIPT};
  if (blocked) return blocked;
  const active = ${DEEP_ACTIVE};
  return target !== undefined && active === target ? null : "retargeted";
})()`);

/** Redacts dialog messages with the document's remembered values. */
export function appRedactDialogsExpression(
  messages: readonly { message: string; truncated: boolean }[],
): string {
  return json(`(() => {
    const state = ${STATE};
    const messages = ${JSON.stringify(messages)};
    if (!state) return messages.map(({ message, truncated }) => truncated ? "" : message);
    const privacy = ${PRIVACY_RUNTIME};
    return messages.map(({ message, truncated }) => privacy.redact(
      state, message, ${MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS}, truncated === true,
    ));
  })()`);
}
