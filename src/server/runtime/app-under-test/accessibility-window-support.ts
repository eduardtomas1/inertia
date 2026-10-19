import type {
  AppControlAction,
  AppControlElementInfo,
  AppControlFailure,
} from "../../../node/runtime-app-control-protocol.js";
import type { AgentBrowserKey } from "../../../shared/agent-browser";
import type { AppUnderTestWindowAccessGate } from "../../../shared/app-under-test";
import { MESSAGES } from "./cdp-window-support";
import type { AppUnderTestWindowFailure } from "./window-transport";

/** Fixed wording and pure helpers of the accessibility window transport. */

export const ACCESSIBILITY_MESSAGES = Object.freeze({
  ...MESSAGES,
  launchGone: "That launch is no longer running. Call inertia_app_status for current launches.",
  denied: "Inertia never reads or controls this window: it belongs to a password manager, a credential or consent prompt, system settings or another protected app.",
  nativeFailure: "A system accessibility call failed, so nothing more was done. Take a new inertia_app_snapshot, then try again.",
  unsupportedAction: "That control does not support this action through the accessibility API. Take a new inertia_app_snapshot and try another control.",
  refused: "The app refused that accessibility action. Take a new inertia_app_snapshot, then try again.",
  noFocus: "No control in this window has keyboard focus. Click or type into a control first, then press the key.",
  notInFront: "The app is not in front; call inertia_app_activate with this windowId, then try again. Keys other than Enter and Space and scrolling by deltaY reach a native window as keyboard and wheel input, which needs the window in front.",
  inputWayland: "Synthesized input is not available on Wayland: the desktop does not let Inertia send keys or wheel input to another app. Use Enter or Space on a focused control, inertia_app_click, inertia_app_type, or inertia_app_scroll with a ref instead.",
  inputUnavailable: "Synthesized keyboard and wheel input is not available on this platform or desktop session. Use Enter or Space on a focused control, inertia_app_click, inertia_app_type, or inertia_app_scroll with a ref instead.",
  activated: "The window was brought to the front. For the rest of this turn inertia_app_press accepts every listed key and inertia_app_scroll accepts deltaY for it, while it stays in front.",
  keptBehind: "The operating system kept the app behind another window, so it is not in front and no keys or wheel input were allowed. Ask the user to bring the app to the front, then call inertia_app_activate again, or use Enter or Space on a focused control, inertia_app_click, inertia_app_type, or inertia_app_scroll with a ref.",
  metaEnter: "Meta+Enter is sent only on macOS. Use Control+Enter or another listed key on this platform.",
  busy: "Too many App control requests are running at once, so nothing was sent. Try again when one finishes.",
  unavailable: "Native window control is unavailable right now, so nothing was sent. Call inertia_app_status, then try again.",
  wayland: "Screenshots are unavailable on Wayland: the desktop does not let Inertia read window pixels. Use inertia_app_snapshot to inspect the window instead.",
  platform: "Native window control is not supported on this platform. Read the app's output with inertia_app_logs instead.",
  elevated: "This window belongs to a process running with higher privileges than Inertia (for example as administrator), so Windows blocks accessibility access to it. Ask the user to start the app without elevation.",
  helperDenied: "macOS lists Inertia as allowed in Accessibility, but denied access to its App control helper, so the window could not be read. Native windows cannot be controlled with this build on this Mac; read the app's output with inertia_app_logs instead.",
  accessibilityTree: "This app is not exposing its accessibility tree, so its window cannot be read. Stop it, ask the user to start the app with ACCESSIBILITY_ENABLED=1 or --force-renderer-accessibility (Chromium and Electron apps), then take a new inertia_app_snapshot.",
  accessibilityBus: "Accessibility support is turned off for this desktop session, so no app's windows can be read. Ask the user to turn on accessibility support (the AT-SPI bus) and restart Inertia, then try again.",
  startFailed: "App control could not start; restart Inertia or check Settings → Devices & integrations → App control. Nothing was sent.",
  treeTooLarge: "The app's process tree is too large to check for protected apps, so nothing was sent. Stop processes the app started, or read its output with inertia_app_logs.",
  sensitiveField: "Screenshots are unavailable while a password or credential field in this window holds a value or while this app holds a value Inertia hid. Clear the field or restart the app to take one.",
  incomplete: "Screenshots are unavailable because Inertia could not check the whole window for protected fields. Close part of the window's content and try again.",
  timeoutBefore: "The window did not answer in time, so nothing was sent. Try again, or check inertia_app_logs.",
  timeoutAfter: "The App action timed out after it may have reached the app. Take a new inertia_app_snapshot before repeating it.",
  contentChanged: "The window's content changed after the action. Take a new inertia_app_snapshot.",
});

/** The next step for a permission or platform gate, by platform. */
export function permissionMessage(platform: NodeJS.Platform, screenRecording: boolean): string {
  if (platform === "darwin") {
    return screenRecording
      ? "macOS has not allowed Inertia to record the screen, so no screenshot was taken. Ask the user to allow Inertia in System Settings → Privacy & Security → Screen Recording (Settings → Devices & integrations → App control opens it), then try again."
      : "macOS has not allowed Inertia to use accessibility, so the app's windows cannot be read. Ask the user to allow Inertia in System Settings → Privacy & Security → Accessibility (Settings → Devices & integrations → App control opens it), then try again.";
  }
  return "The system denied accessibility access to this app's windows. Ask the user to check that accessibility support is turned on for the desktop session, then try again.";
}

/** Maps a typed App control failure to the pack's failure shape; never carries native text. */
export function accessibilityFailure(
  failure: AppControlFailure,
  platform: NodeJS.Platform,
): AppUnderTestWindowFailure {
  const { dispatched } = failure;
  const result = (code: AppUnderTestWindowFailure["code"], message: string): AppUnderTestWindowFailure => ({
    ok: false, code, message, dispatched,
  });
  switch (failure.code) {
    case "permission-denied":
      return result("unavailable", permissionMessage(platform, failure.reason === "screen-recording"));
    case "helper-permission-denied":
      return result("unavailable", ACCESSIBILITY_MESSAGES.helperDenied);
    case "accessibility-unavailable":
      // An empty tree is the app's own; a disabled bus blocks every app.
      return result("unavailable", failure.reason === "empty-tree" ? ACCESSIBILITY_MESSAGES.accessibilityTree : ACCESSIBILITY_MESSAGES.accessibilityBus);
    case "not-found":
      return result("not-found", failure.reason === "window-gone"
        ? ACCESSIBILITY_MESSAGES.gone
        : failure.reason === "launch-gone"
          ? ACCESSIBILITY_MESSAGES.launchGone
          : failure.reason === "changed" ? ACCESSIBILITY_MESSAGES.changed : ACCESSIBILITY_MESSAGES.stale);
    case "denied":
      return result("invalid", ACCESSIBILITY_MESSAGES.denied);
    case "native-failure":
      return result("unavailable", failure.reason === "start-failed" ? ACCESSIBILITY_MESSAGES.startFailed : ACCESSIBILITY_MESSAGES.nativeFailure);
    case "timeout":
      return result("timeout", dispatched ? ACCESSIBILITY_MESSAGES.timeoutAfter : ACCESSIBILITY_MESSAGES.timeoutBefore);
    case "invalid":
      return result("invalid", failure.reason === "disabled"
        ? ACCESSIBILITY_MESSAGES.disabled
        : failure.reason === "not-editable"
          ? ACCESSIBILITY_MESSAGES.notEditable
          : failure.reason === "action-unsupported"
            ? ACCESSIBILITY_MESSAGES.unsupportedAction
            : failure.reason === "no-focus"
              ? ACCESSIBILITY_MESSAGES.noFocus
              : failure.reason === "key-unsupported" ? ACCESSIBILITY_MESSAGES.metaEnter : ACCESSIBILITY_MESSAGES.refused);
    case "unsupported":
      return result("unavailable", failure.reason === "wayland"
        ? ACCESSIBILITY_MESSAGES.wayland
        : failure.reason === "input-wayland"
          ? ACCESSIBILITY_MESSAGES.inputWayland
          : failure.reason === "input-unavailable" ? ACCESSIBILITY_MESSAGES.inputUnavailable : ACCESSIBILITY_MESSAGES.platform);
    case "elevated":
      return result("unavailable", ACCESSIBILITY_MESSAGES.elevated);
    case "cancelled":
      return result("cancelled", "The App action was cancelled.");
    case "sensitive":
      return result("sensitive", failure.reason === "incomplete" ? ACCESSIBILITY_MESSAGES.incomplete : ACCESSIBILITY_MESSAGES.sensitiveField);
    case "busy":
      return result("too-large", ACCESSIBILITY_MESSAGES.busy);
    case "unavailable":
      return result("unavailable", failure.reason === "tree-too-large"
        ? ACCESSIBILITY_MESSAGES.treeTooLarge
        : failure.reason === "not-foreground" ? ACCESSIBILITY_MESSAGES.notInFront : ACCESSIBILITY_MESSAGES.unavailable);
  }
}

/** The fixed gate category of a failure that blocks every read of the launch until the user acts, or null. */
export function gateCategory(failure: AppControlFailure): AppUnderTestWindowAccessGate | null {
  switch (failure.code) {
    // A Screen Recording denial blocks screenshots only; windows stay readable.
    case "permission-denied": return failure.reason === "screen-recording" ? null : "permission";
    case "helper-permission-denied": return "helper-permission";
    case "accessibility-unavailable": return failure.reason === "empty-tree" ? "accessibility-tree" : "accessibility-bus";
    // The worker failed to load three times: polling backs off until the user acts.
    case "native-failure": return failure.reason === "start-failed" ? "start-failed" : null;
    case "elevated": return "elevated";
    // Wayland blocks screenshots and synthesized input only; windows stay readable.
    case "unsupported": return failure.reason === "wayland" || failure.reason === "input-wayland" || failure.reason === "input-unavailable"
      ? null
      : "unsupported";
    default: return null;
  }
}

/** Failures that mean nothing in this launch can be read until the user acts. */
export function gateFailure(failure: AppControlFailure): boolean {
  return gateCategory(failure) !== null;
}

const SELECT_ROLES = new Set(["list_item", "tab", "tree_item", "row", "cell", "option"]);

/** The accessibility action a click maps to, chosen by the control's role and state. */
export function clickAction(target: Pick<AppControlElementInfo, "role" | "checked" | "expanded" | "actions">): AppControlAction {
  const advertises = (name: string): boolean => target.actions.includes(name);
  if (target.checked !== null && (advertises("toggle") || !advertises("press"))) return "toggle";
  if (SELECT_ROLES.has(target.role) && (advertises("select") || !advertises("press"))) return "select";
  if (target.expanded !== null && !advertises("press") && (advertises("expand") || target.actions.length === 0)) return "expand";
  return "press";
}

/** Only Enter and Space have an accessibility equivalent: activating the focused control. */
export function keyAction(key: AgentBrowserKey): "press" | null {
  return key === "Enter" || key === "Space" ? "press" : null;
}

/**
 * How a native window receives a destructive command in this turn. Clicks,
 * text and scrolling a ref into view are accessibility actions; so are Enter
 * and Space until the window is brought to the front. Every other key, any
 * key once the window holds this turn's foreground grant, and a pixel scroll
 * are synthesized input.
 */
export function nativeInputRoute(
  command: { action: string; key?: AgentBrowserKey; ref?: string; deltaY?: number },
  granted: boolean,
): "accessibility" | "synthesized" {
  if (command.action === "press") return granted || keyAction(command.key!) === null ? "synthesized" : "accessibility";
  if (command.action === "scroll") return command.ref === undefined ? "synthesized" : "accessibility";
  return "accessibility";
}
