import type { HiddenProviderInstruction } from "./request-context";

export const RUNTIME_INTERRUPTION_REASONS: readonly string[] = ["runtime-restart", "runtime-shutdown", "runtime-crash"];
export const MAX_RUNTIME_INTERRUPTION_ENTRIES = 10;
const MAX_LABEL_CHARACTERS = 160;
const MAX_NOTE_BYTES = 4 * 1024;
const OMITTED_LINE_RESERVE_BYTES = 32;

export interface RuntimeInterruption {
  request: string | null;
  lostTasks: readonly string[];
  lostTaskCount: number;
}

function compactLabel(value: string): string {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim());
  return characters.length > MAX_LABEL_CHARACTERS
    ? `${characters.slice(0, MAX_LABEL_CHARACTERS - 1).join("")}…`
    : characters.join("");
}

export function runtimeInterruptionInstruction(interruption: RuntimeInterruption): HiddenProviderInstruction {
  const request = interruption.request ? compactLabel(interruption.request) : "";
  const lines = [
    "Inertia stopped while your previous turn was running, so that turn was interrupted before it finished. Check the workspace before relying on work from it.",
    ...(request ? [`Interrupted request: ${request}`] : []),
  ];
  const tasks = interruption.lostTasks.slice(0, MAX_RUNTIME_INTERRUPTION_ENTRIES).map(compactLabel).filter(Boolean);
  if (interruption.lostTaskCount > 0) {
    lines.push("This delegated work was lost and will not report back:");
    let bytes = Buffer.byteLength(lines.join("\n"), "utf8");
    let shown = 0;
    for (const task of tasks) {
      const line = `- ${task}`;
      const next = bytes + 1 + Buffer.byteLength(line, "utf8");
      if (next + OMITTED_LINE_RESERVE_BYTES > MAX_NOTE_BYTES) break;
      lines.push(line);
      bytes = next;
      shown += 1;
    }
    const omitted = interruption.lostTaskCount - shown;
    if (omitted > 0) lines.push(`- and ${omitted} more`);
  }
  return { label: "runtime-interruption", text: lines.join("\n") };
}
