import type { AgentActivity } from "./contracts/agent";

const SHELL_WRAPPER_PATTERN =
  /^(?:(?:\/usr)?\/bin\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/u;
const LEADING_CD_PATTERN = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/u;
const SETUP_LINE_PATTERN =
  /^(?:#|export\s+[A-Za-z_][A-Za-z0-9_]*=|set\s+[-+][a-zA-Z]+|cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*$|source\s+\S+\s*$|\.\s+\S+\s*$)/u;
const HOST_TOOL_TITLE =
  /^(?:Tool\s*·\s*)?(?:mcp_{1,2})?(?:inertia-chat-manager(?:_{1,2}|\s*:\s*))?(inertia_[a-z0-9_]+)(?:\s*:.*)?$/u;
const HOST_TOOL_LABELS: Readonly<Record<string, readonly [running: string, done: string, failed: string]>> = {
  inertia_render_html: ["Rendering a page", "Rendered a page", "Could not render a page"],
  // App under test. Fixed wording only: never the window title, typed text,
  // control names or app output, which are untrusted.
  inertia_app_launch: ["Launching the app", "Launched the app", "Could not launch the app"],
  inertia_app_status: ["Checking the app", "Checked the app", "Could not check the app"],
  inertia_app_logs: ["Reading app logs", "Read app logs", "Could not read app logs"],
  inertia_app_stop: ["Stopping the app", "Stopped the app", "Could not stop the app"],
  inertia_app_windows: ["Listing app windows", "Listed app windows", "Could not list app windows"],
  inertia_app_snapshot: ["Inspecting an app window", "Inspected an app window", "Could not inspect an app window"],
  inertia_app_click: ["Clicking in the app", "Clicked in the app", "Could not click in the app"],
  inertia_app_type: ["Typing in the app", "Typed in the app", "Could not type in the app"],
  inertia_app_press: ["Pressing a key in the app", "Pressed a key in the app", "Could not press a key in the app"],
  inertia_app_scroll: ["Scrolling the app", "Scrolled the app", "Could not scroll the app"],
  inertia_app_wait_for: ["Waiting in the app", "Waited in the app", "Could not wait in the app"],
  inertia_app_screenshot: ["Capturing app evidence", "Captured app evidence", "Could not capture app evidence"],
};

export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = SHELL_WRAPPER_PATTERN.exec(trimmed);
  if (!match) return trimmed;
  let body = match[1]!.trim();
  const quote = body[0];
  if (
    (quote === "'" || quote === "\"")
    && body.length >= 2
    && body.endsWith(quote)
  ) {
    body = body.slice(1, -1);
  }
  return body.replace(/'"'"'/gu, "'").trim();
}

export function commandDisplayText(command: string): string {
  const lines = unwrapShellCommand(command)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = lines.find((line) => !SETUP_LINE_PATTERN.test(line))
    ?? lines[0]
    ?? "";
  return meaningful.replace(LEADING_CD_PATTERN, "");
}

export function hostToolActivityTitle(
  activity: Pick<AgentActivity, "kind" | "title" | "status">,
): string | null {
  if (activity.kind !== "tool") return null;
  const name = HOST_TOOL_TITLE.exec(activity.title.trim())?.[1];
  const labels = name === undefined ? undefined : HOST_TOOL_LABELS[name];
  if (!labels) return null;
  return activity.status === "running" ? labels[0] : activity.status === "failed" ? labels[2] : labels[1];
}
