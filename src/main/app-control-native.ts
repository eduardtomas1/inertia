import { createHash } from "node:crypto";

import {
  APP_CONTROL_MAX_ACTION_NAMES,
  APP_CONTROL_MAX_DEPTH,
  APP_CONTROL_MAX_ELEMENTS,
  APP_CONTROL_MAX_LISTED_WINDOWS,
  APP_CONTROL_MAX_NAME_CHARS,
  APP_CONTROL_MAX_NODE_VISITS,
  APP_CONTROL_MAX_PAYLOAD_BYTES,
  APP_CONTROL_MAX_ROLE_CHARS,
  APP_CONTROL_MAX_TEXT_CHARS,
  APP_CONTROL_MAX_VALUE_CHARS,
  APP_CONTROL_MAX_WORKER_TITLE_CHARS,
  APP_CONTROL_WALK_MS,
  appControlPayloadBytes,
  type AppControlAction,
  type AppControlElementInfo,
  type AppControlExpectation,
  type AppControlFailureCode,
  type AppControlFailureReason,
  type AppControlRect,
  type AppControlValue,
  type AppControlWindowInfo,
} from "../node/runtime-app-control-protocol.js";
import { appControlNameDenied } from "../shared/app-control-denylist.js";
import {
  PREVIEW_AGENT_NAME_WORD_SOURCE,
  PREVIEW_AGENT_SENSITIVE_NAME_SOURCE,
} from "../shared/preview-agent-sensitive-fields.js";

/**
 * The App control worker's logic over an injected accessibility module (the
 * real one is `@crowecawcaw/xa11y`; tests pass a fake). It reads and acts only
 * on windows of the processes main named as the launch's owned tree, never on
 * a denied app, and only through accessibility actions: no synthesized mouse
 * or keyboard input. Every walk is bounded by node visits, depth and time.
 * Window text is untrusted data: it is bounded and stripped of control
 * characters here and sanitized again by the runtime.
 */

export interface NativeRect { x: number; y: number; width: number; height: number }

export interface NativeElement {
  readonly role: string;
  readonly name: string | null;
  readonly value: string | null;
  readonly stableId: string | null;
  readonly pid: number | null;
  readonly actions: string[];
  readonly bounds: NativeRect | null;
  readonly raw: Record<string, unknown>;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly active: boolean;
  readonly checked: "on" | "off" | "mixed" | null;
  readonly expanded: boolean | null;
  readonly editable: boolean;
  children(): Promise<NativeElement[]>;
  press(): Promise<void>;
  focus(): Promise<void>;
  toggle(): Promise<void>;
  select(): Promise<void>;
  expand(): Promise<void>;
  scrollIntoView(): Promise<void>;
  setValue(value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  activate(): Promise<void>;
}

export interface NativeApp {
  readonly name: string;
  readonly pid: number | null;
  windows(): Promise<NativeElement[]>;
  asElement(): { readonly raw: Record<string, unknown> };
}

export interface NativeErrors {
  PermissionDeniedError: abstract new (...args: never[]) => Error;
  AccessibilityNotEnabledError: abstract new (...args: never[]) => Error;
  SelectorNotMatchedError: abstract new (...args: never[]) => Error;
  ActionNotSupportedError: abstract new (...args: never[]) => Error;
  InvalidActionDataError: abstract new (...args: never[]) => Error;
}

export interface NativeModule {
  /** `byPid` answers null when no accessibility application has that pid. */
  App: { list(): Promise<NativeApp[]>; byPid?(pid: number): Promise<NativeApp | null> };
  errors: NativeErrors;
}

/** Processes the launch owns; only their windows are visible, denied ones never addressable. */
export interface AppControlScope {
  pids: ReadonlySet<number>;
  deniedPids: ReadonlySet<number>;
}

export class AppControlNativeFailure extends Error {
  constructor(
    readonly code: AppControlFailureCode,
    readonly reason: AppControlFailureReason | null = null,
    readonly dispatched = false,
  ) {
    super(code);
  }
}

export interface ResolvedWindow {
  app: NativeApp;
  window: NativeElement;
  pid: number;
  token: string;
}

/** A listed window; a denied app is listed once, without reading its windows. */
export type ListedWindow =
  | (ResolvedWindow & { denied: false })
  | { app: NativeApp; window: null; pid: number; token: string; denied: true };

export interface WalkedNode {
  element: NativeElement;
  token: string;
  depth: number;
  /** A password role or an editable control whose name words name a credential. */
  sensitive: boolean;
}

const MAX_APPS = 64;
/** A tree of at most this many processes is looked up pid by pid instead of listing every application. */
const MAX_BY_PID_LOOKUPS = 16;
const MAX_WINDOWS_PER_APP = 16;
const MAX_ROOT_CHILDREN = 16;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const PASSWORD = /password|secure/iu;
const SENSITIVE_NAME = new RegExp(PREVIEW_AGENT_SENSITIVE_NAME_SOURCE, "u");
const NAME_WORDS = new RegExp(PREVIEW_AGENT_NAME_WORD_SOURCE, "gu");
const INTERACTIVE_ROLES = new Set([
  "button", "push_button", "toggle_button", "split_button", "menu_button", "check_box", "radio_button", "switch",
  "combo_box", "list_box", "text_field", "text_area", "password_text", "search_field", "entry", "spin_button",
  "slider", "link", "menu_item", "check_menu_item", "radio_menu_item", "tab", "list_item", "tree_item", "row",
  "cell", "disclosure_triangle", "color_well", "date_picker",
]);
const STRUCTURAL_ROLES = new Set([
  "application", "window", "dialog", "group", "panel", "filler", "pane", "scroll_area", "scroll_pane", "split_pane",
  "layered_pane", "root_pane", "viewport", "section", "generic", "unknown", "separator", "web_area", "document",
  "frame", "internal_frame", "tool_bar", "menu_bar", "status_bar", "tab_list", "tab_group", "list", "table", "tree",
]);
const ACTION_VERBS = new Set(["press", "click", "activate", "toggle", "select", "expand", "collapse", "jump"]);
const SCREENSHOT_EDITABLE = /text_field|text_area|password|secure|entry|editable|search/iu;

export function appControlDigest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.slice(0, maximum * 2).replace(CONTROL, "").slice(0, maximum) : "";
}

/** The Browser's credential-name rule, applied to an accessibility name. */
export function sensitiveControlName(name: string | null): boolean {
  if (!name) return false;
  if (name.length > 1_200) return true;
  return SENSITIVE_NAME.test((name.match(NAME_WORDS) ?? []).join(" ").toLowerCase());
}

export function isPasswordElement(element: Pick<NativeElement, "role" | "raw">): boolean {
  const raw = element.raw ?? {};
  return PASSWORD.test(element.role)
    || PASSWORD.test(String(raw.ax_subrole ?? ""))
    || PASSWORD.test(String(raw.atspi_role ?? ""))
    || raw.is_password === true
    || raw.uia_is_password === true;
}

export function isSensitiveElement(element: Pick<NativeElement, "role" | "raw" | "name" | "editable">): boolean {
  return isPasswordElement(element) || (element.editable && sensitiveControlName(element.name));
}

export function isInteractive(element: Pick<NativeElement, "role" | "editable" | "actions">): boolean {
  if (element.editable || INTERACTIVE_ROLES.has(element.role)) return true;
  if (STRUCTURAL_ROLES.has(element.role)) return false;
  return element.actions.some((action) => ACTION_VERBS.has(action));
}

function finiteRect(bounds: NativeRect | null | undefined): NativeRect | null {
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  return [x, y, width, height].every(Number.isFinite) && width >= 0 && height >= 0
    && Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000 && width <= 1_000_000 && height <= 1_000_000
    ? { x, y, width, height }
    : null;
}

function bundleId(app: NativeApp): string | null {
  let raw: Record<string, unknown>;
  try { raw = app.asElement().raw ?? {}; } catch { return null; }
  for (const [key, value] of Object.entries(raw).slice(0, 64)) {
    if (/bundle/iu.test(key) && typeof value === "string") return value.slice(0, 512);
  }
  return null;
}

/**
 * A node's identity within its window: xa11y's `stableId`, or else its path,
 * role and (for controls, `named`) its cleaned name, so a renamed control at
 * the same position is a different control.
 */
function nodeIdentity(element: NativeElement, path: string, named: boolean): string {
  if (element.stableId) return `id:${element.stableId.slice(0, 512)}`;
  const base = `path:${path}:${element.role.slice(0, 80)}`;
  return named ? `${base}:${cleanText(element.name, APP_CONTROL_MAX_NAME_CHARS)}` : base;
}

/** Maps a native error to a failure category; never carries native text. */
export function nativeFailure(error: unknown, errors: NativeErrors, dispatched = false): AppControlNativeFailure {
  if (error instanceof AppControlNativeFailure) return error;
  if (error instanceof errors.PermissionDeniedError) return new AppControlNativeFailure("permission-denied", null, dispatched);
  if (error instanceof errors.AccessibilityNotEnabledError) return new AppControlNativeFailure("accessibility-unavailable", null, dispatched);
  if (error instanceof errors.SelectorNotMatchedError) return new AppControlNativeFailure("not-found", "stale", dispatched);
  if (error instanceof errors.ActionNotSupportedError) return new AppControlNativeFailure("invalid", "action-unsupported", dispatched);
  if (error instanceof errors.InvalidActionDataError) return new AppControlNativeFailure("invalid", null, dispatched);
  return new AppControlNativeFailure("native-failure", null, dispatched);
}

export interface AppControlNativeOptions {
  now?(): number;
  /** UIPI pre-flight (Windows): true when the window's process is more privileged than Inertia. */
  elevated?(pid: number): boolean;
  /** Linux reports a window without accessible content as the app not exposing its tree. */
  platform?: NodeJS.Platform;
}

export class AppControlNative {
  private readonly now: () => number;

  constructor(private readonly native: NativeModule, private readonly options: AppControlNativeOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Every window of the owned tree; denied ones without a token. */
  /** The accessibility applications of the owned tree, looked up by pid when the tree is small. */
  private async apps(scope: AppControlScope): Promise<NativeApp[]> {
    const { App } = this.native;
    if (App.byPid && scope.pids.size > 0 && scope.pids.size <= MAX_BY_PID_LOOKUPS) {
      const apps: NativeApp[] = [];
      for (const pid of scope.pids) {
        const app = await App.byPid(pid);
        if (app && app.pid === pid) apps.push(app);
      }
      return apps;
    }
    // An empty scope (the Settings probe) still lists, which is what tells a working bus from a missing one.
    return (await App.list()).filter((app) => app.pid !== null && scope.pids.has(app.pid));
  }

  async listWindows(scope: AppControlScope): Promise<ListedWindow[]> {
    const apps = (await this.apps(scope)).slice(0, MAX_APPS);
    const seen = new Set<string>();
    const listed: ListedWindow[] = [];
    for (const app of apps) {
      const pid = app.pid!;
      const denied = scope.deniedPids.has(pid) || appControlNameDenied({ appName: app.name, bundleId: bundleId(app) });
      const windows = denied ? [] : (await app.windows()).slice(0, MAX_WINDOWS_PER_APP);
      if (denied) {
        // A denied app is listed once, without reading its windows.
        const token = appControlDigest([pid, "denied"]);
        if (!seen.has(token)) {
          seen.add(token);
          listed.push({ app, window: null, pid, token, denied: true });
        }
        continue;
      }
      windows.forEach((window, index) => {
        const token = appControlDigest([pid, "window", window.stableId ? `id:${window.stableId.slice(0, 512)}` : `#${index}:${window.role}`]);
        if (seen.has(token)) return;
        seen.add(token);
        listed.push({ app, window, pid, token, denied: false });
      });
    }
    return listed;
  }

  /**
   * The listed windows within the 24 KiB payload: titles are cut in the
   * worker, and the newest windows are left out (and counted) until it fits.
   */
  async windows(scope: AppControlScope): Promise<Extract<AppControlValue, { kind: "windows" }>> {
    const listed = await this.listWindows(scope);
    const windows: AppControlWindowInfo[] = listed.slice(0, APP_CONTROL_MAX_LISTED_WINDOWS).map((entry) => (entry.denied
      ? { token: null, pid: entry.pid, title: "", active: false, denied: true, bounds: null }
      : {
          token: entry.token,
          pid: entry.pid,
          title: cleanText(entry.window.name, APP_CONTROL_MAX_WORKER_TITLE_CHARS),
          active: entry.window.active === true,
          denied: false,
          bounds: finiteRect(entry.window.bounds),
        }));
    const value = { kind: "windows" as const, windows, omitted: listed.length - windows.length };
    while (windows.length > 0 && appControlPayloadBytes({ ok: true, value }) > APP_CONTROL_MAX_PAYLOAD_BYTES - 256) {
      windows.pop();
      value.omitted += 1;
    }
    return value;
  }

  async resolve(scope: AppControlScope, token: string): Promise<ResolvedWindow> {
    const found = (await this.listWindows(scope)).find((entry): entry is ResolvedWindow & { denied: false } => (
      !entry.denied && entry.token === token
    ));
    if (!found) {
      // A denied window never matches by token; one outside the tree is not found.
      throw new AppControlNativeFailure("not-found", "window-gone");
    }
    if (this.options.elevated?.(found.pid)) throw new AppControlNativeFailure("elevated");
    return found;
  }

  /** The window's root identity: its direct children. Changes when its content root is replaced. */
  async rootKey(resolved: ResolvedWindow, known?: readonly NativeElement[]): Promise<string> {
    const children = (known ?? await resolved.window.children()).slice(0, MAX_ROOT_CHILDREN);
    return appControlDigest([resolved.token, ...children.map((child, index) => nodeIdentity(child, String(index), false))]);
  }

  /**
   * Visits the window's subtree depth first within the visit, depth and time
   * bounds. `visit` returns false to stop. Reports whether the walk was cut.
   */
  async walk(
    resolved: ResolvedWindow,
    visit: (node: WalkedNode) => boolean | void,
  ): Promise<{ complete: boolean; visited: number }> {
    const deadline = this.now() + APP_CONTROL_WALK_MS;
    let visited = 0;
    let complete = true;
    let stopped = false;
    const step = async (element: NativeElement, path: string, depth: number): Promise<void> => {
      if (stopped) return;
      if (visited >= APP_CONTROL_MAX_NODE_VISITS || depth > APP_CONTROL_MAX_DEPTH || this.now() > deadline) {
        complete = false;
        return;
      }
      visited += 1;
      const token = appControlDigest([resolved.token, nodeIdentity(element, path, true)]);
      if (visit({ element, token, depth, sensitive: isSensitiveElement(element) }) === false) {
        stopped = true;
        return;
      }
      if (isSensitiveElement(element)) return;
      const children = await element.children();
      for (let index = 0; index < children.length; index += 1) {
        if (stopped) return;
        if (visited >= APP_CONTROL_MAX_NODE_VISITS || this.now() > deadline) {
          complete = false;
          return;
        }
        await step(children[index]!, `${path}/${index}`, depth + 1);
      }
    };
    const children = await resolved.window.children();
    for (let index = 0; index < children.length && !stopped; index += 1) {
      await step(children[index]!, String(index), 1);
    }
    return { complete: complete || stopped, visited };
  }

  elementInfo(node: WalkedNode, windowBounds: NativeRect | null): AppControlElementInfo {
    const { element } = node;
    const bounds = finiteRect(element.bounds);
    const origin = finiteRect(windowBounds);
    const rect: AppControlRect | null = bounds
      ? origin ? { ...bounds, x: bounds.x - origin.x, y: bounds.y - origin.y } : bounds
      : null;
    const outside = rect !== null && origin !== null
      && (rect.x + rect.width <= 0 || rect.y + rect.height <= 0 || rect.x >= origin.width || rect.y >= origin.height);
    const name = cleanText(element.name, APP_CONTROL_MAX_NAME_CHARS);
    const value = node.sensitive
      ? "[redacted]"
      : typeof element.value === "string" ? cleanText(element.value, APP_CONTROL_MAX_VALUE_CHARS) : null;
    return {
      token: node.token,
      role: cleanText(element.role, APP_CONTROL_MAX_ROLE_CHARS) || "control",
      name: name || (node.sensitive ? "Sensitive field" : ""),
      value,
      enabled: element.enabled !== false,
      focused: element.focused === true,
      checked: element.checked === "on" || element.checked === "off" || element.checked === "mixed" ? element.checked : null,
      expanded: typeof element.expanded === "boolean" ? element.expanded : null,
      editable: element.editable === true,
      sensitive: node.sensitive,
      offscreen: element.visible === false || outside,
      rect,
      actions: element.actions.filter((action) => /^[a-z][a-z0-9_]{0,31}$/u.test(action)).slice(0, APP_CONTROL_MAX_ACTION_NAMES),
    };
  }

  async snapshot(scope: AppControlScope, token: string): Promise<Extract<AppControlValue, { kind: "snapshot" }>> {
    const resolved = await this.resolve(scope, token);
    const children = await resolved.window.children();
    // AT-SPI lists a Chromium or Electron window that exposes no tree as an empty root.
    if (this.options.platform === "linux" && children.length === 0) {
      throw new AppControlNativeFailure("accessibility-unavailable", "empty-tree");
    }
    const rootKey = await this.rootKey(resolved, children);
    const windowBounds = finiteRect(resolved.window.bounds);
    const elements: AppControlElementInfo[] = [];
    const text: string[] = [];
    let textChars = 0;
    let omittedTextChars = 0;
    let omittedElements = 0;
    let unlabelled = false;
    let sensitiveFilled = false;
    const walked = await this.walk(resolved, (node) => {
      const { element } = node;
      if (node.sensitive && typeof element.value === "string" && element.value.length > 0) sensitiveFilled = true;
      if (isInteractive(element) || node.sensitive) {
        if (elements.length < APP_CONTROL_MAX_ELEMENTS) elements.push(this.elementInfo(node, windowBounds));
        else omittedElements += 1;
        return;
      }
      const name = cleanText(element.name, APP_CONTROL_MAX_NAME_CHARS * 4);
      const value = element.editable ? "" : cleanText(element.value, APP_CONTROL_MAX_VALUE_CHARS * 4);
      const piece = [name, value && value !== name ? value : ""].filter(Boolean).join(" ").trim();
      if (!piece) {
        if (!STRUCTURAL_ROLES.has(element.role) && element.role !== "static_text") unlabelled = true;
        return;
      }
      if (text.at(-1) === piece) return;
      const room = APP_CONTROL_MAX_TEXT_CHARS - textChars;
      if (room <= 0) {
        omittedTextChars += piece.length;
        return;
      }
      const kept = piece.slice(0, Math.max(0, room - (text.length > 0 ? 1 : 0)));
      omittedTextChars += piece.length - kept.length;
      if (kept) {
        text.push(kept);
        textChars += kept.length + (text.length > 1 ? 1 : 0);
      }
    });
    const value: Extract<AppControlValue, { kind: "snapshot" }> = {
      kind: "snapshot",
      rootKey,
      title: cleanText(resolved.window.name, APP_CONTROL_MAX_WORKER_TITLE_CHARS),
      bounds: windowBounds,
      text: text.join("\n").slice(0, APP_CONTROL_MAX_TEXT_CHARS),
      elements,
      omittedTextChars,
      omittedElements,
      readLimitReached: !walked.complete,
      unlabelled,
      sensitiveFilled,
    };
    return fitSnapshot(value);
  }

  /** The element with `token`, or the focused control for `null`. */
  async find(resolved: ResolvedWindow, token: string | null): Promise<WalkedNode | null> {
    let found: WalkedNode | null = null;
    await this.walk(resolved, (node) => {
      if (token === null ? node.element.focused : node.token === token) {
        found = node;
        return false;
      }
      return true;
    });
    return found;
  }

  async inspect(scope: AppControlScope, token: string, element: string | null): Promise<Extract<AppControlValue, { kind: "inspect" }>> {
    const resolved = await this.resolve(scope, token);
    const rootKey = await this.rootKey(resolved);
    const node = await this.find(resolved, element);
    if (element !== null && !node) throw new AppControlNativeFailure("not-found", "stale");
    return { kind: "inspect", rootKey, element: node ? this.elementInfo(node, finiteRect(resolved.window.bounds)) : null };
  }

  async perform(
    scope: AppControlScope,
    token: string,
    element: string | null,
    action: AppControlAction,
    text: string | null,
    expect: AppControlExpectation | null,
  ): Promise<Extract<AppControlValue, { kind: "perform" }>> {
    const resolved = await this.resolve(scope, token);
    if (expect && await this.rootKey(resolved) !== expect.rootKey) throw new AppControlNativeFailure("not-found", "changed");
    if (element === null && action === "activate") {
      await this.dispatch(() => resolved.window.activate());
      return await this.after(scope, resolved);
    }
    const node = await this.find(resolved, element);
    if (!node) throw new AppControlNativeFailure(element === null ? "invalid" : "not-found", element === null ? "no-focus" : "stale");
    const target = node.element;
    if (expect && (cleanText(target.role, APP_CONTROL_MAX_ROLE_CHARS) || "control") !== expect.role) {
      throw new AppControlNativeFailure("not-found", "changed");
    }
    if (expect && this.elementInfo(node, finiteRect(resolved.window.bounds)).name !== expect.name) {
      throw new AppControlNativeFailure("not-found", "changed");
    }
    if (target.enabled === false) throw new AppControlNativeFailure("invalid", "disabled");
    if ((action === "setValue" || action === "typeText") && !target.editable) {
      throw new AppControlNativeFailure("invalid", "not-editable");
    }
    await this.dispatch(async () => {
      switch (action) {
        case "setValue":
        case "typeText":
          // Focus is best effort: some toolkits accept a value without it.
          await target.focus().catch(() => undefined);
          await (action === "setValue" ? target.setValue(text ?? "") : target.typeText(text ?? ""));
          return;
        case "press": return await target.press();
        case "focus": return await target.focus();
        case "toggle": return await target.toggle();
        case "select": return await target.select();
        case "expand": return await target.expand();
        case "scrollIntoView": return await target.scrollIntoView();
        case "activate": return await target.activate();
      }
    });
    return await this.after(scope, resolved);
  }

  private async dispatch(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      const failure = nativeFailure(error, this.native.errors, true);
      // A refused action (unsupported, invalid data) never reached the app.
      throw failure.code === "invalid" ? new AppControlNativeFailure(failure.code, failure.reason, false) : failure;
    }
  }

  private async after(scope: AppControlScope, resolved: ResolvedWindow): Promise<Extract<AppControlValue, { kind: "perform" }>> {
    const listed: ListedWindow[] = await this.listWindows(scope).catch(() => []);
    const still = listed.find((entry): entry is ResolvedWindow & { denied: false } => !entry.denied && entry.token === resolved.token);
    if (!still) return { kind: "perform", rootKey: null, windowClosed: true };
    return { kind: "perform", rootKey: await this.rootKey(still).catch(() => null), windowClosed: false };
  }

  /**
   * For a screenshot: refuses when a sensitive field holds a value or the walk
   * was cut, and returns the window-relative bounds of every protected field
   * to mask (Snapshots' rule: every editable control and every sensitive one).
   */
  async screenshotPlan(resolved: ResolvedWindow): Promise<{ bounds: NativeRect; masks: NativeRect[] }> {
    const bounds = finiteRect(resolved.window.bounds);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || bounds.width * bounds.height > 16_000_000) {
      throw new AppControlNativeFailure("unavailable");
    }
    const masks: NativeRect[] = [];
    let filled = false;
    let unlocated = false;
    const walked = await this.walk(resolved, (node) => {
      const { element } = node;
      if (node.sensitive && typeof element.value === "string" && element.value.length > 0) filled = true;
      if (node.sensitive || element.editable || SCREENSHOT_EDITABLE.test(element.role)) {
        const rect = finiteRect(element.bounds);
        if (rect) masks.push(rect);
        else if (element.visible !== false) unlocated = true;
      }
    });
    if (filled) throw new AppControlNativeFailure("sensitive");
    if (!walked.complete || unlocated) throw new AppControlNativeFailure("sensitive", "incomplete");
    return { bounds, masks };
  }
}

/** Keeps a snapshot within the 24 KiB worker payload: text first, then the farthest elements. */
export function fitSnapshot(value: Extract<AppControlValue, { kind: "snapshot" }>): Extract<AppControlValue, { kind: "snapshot" }> {
  const fitted = { ...value, elements: [...value.elements] };
  const fits = (): boolean => appControlPayloadBytes({ ok: true, value: fitted }) <= APP_CONTROL_MAX_PAYLOAD_BYTES - 256;
  if (fits()) return fitted;
  for (const limit of [6_000, 3_000, 1_000]) {
    if (fitted.text.length <= limit) continue;
    fitted.omittedTextChars += fitted.text.length - limit;
    fitted.text = fitted.text.slice(0, limit);
    if (fits()) return fitted;
  }
  while (!fits() && fitted.elements.length > 0) {
    // Off-screen controls go first, then the last ones in reading order.
    let index = fitted.elements.length - 1;
    for (let candidate = index; candidate >= 0; candidate -= 1) {
      if (fitted.elements[candidate]!.offscreen) {
        index = candidate;
        break;
      }
    }
    fitted.elements.splice(index, 1);
    fitted.omittedElements += 1;
  }
  if (!fits()) {
    fitted.omittedTextChars += fitted.text.length;
    fitted.text = "";
  }
  return fitted;
}
