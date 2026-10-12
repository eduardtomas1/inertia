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
