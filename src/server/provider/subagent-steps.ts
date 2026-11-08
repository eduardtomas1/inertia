import type { SubagentTaskStep } from "../../shared/contracts";
import {
  MAX_SUBAGENT_STEP_LABEL_CHARS,
  MAX_SUBAGENT_STEPS,
} from "../../shared/subagent-task-limits";
import { scrubCommandSecrets } from "./command-secrets";
import { boundedSubagentLabel, MAX_SUBAGENT_LABEL_CHARS } from "./subagent-trace";

const MAX_STEP_KEY_INPUT_CHARS = 160;

/**
 * Inputs that say what a tool call is about without carrying file contents,
 * diffs or output. Order is preference: a command beats the path it runs in.
 */
const STEP_KEY_INPUT_FIELDS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "notebook_path",
  "pattern",
  "path",
  "url",
  "query",
  "description",
] as const;

function firstLine(value: string): string | null {
  const line = value
    .replace(/\0/gu, "")
    .split(/\r\n?|\n/u)
    .map((part) => part.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").replace(/\s+/gu, " ").trim())
    .find(Boolean);
  return line ?? null;
}

/**
 * Scrubs one line of provider text as a command before it is cut, so a cut
 * never leaves part of a secret behind its flag, assignment or URL key.
 */
function scrubbedLine(value: string, maxChars: number): string | null {
  const line = firstLine(value);
  return line ? boundedSubagentLabel(scrubCommandSecrets(line), maxChars) : null;
}

/** One key input of a provider tool call, reduced to its first line. */
export function subagentStepKeyInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const field of STEP_KEY_INPUT_FIELDS) {
    const value = record[field];
    const text = typeof value === "string"
      ? value
      : Array.isArray(value) && value.every((part) => typeof part === "string")
        ? value.join(" ")
        : null;
    const line = text ? scrubbedLine(text, MAX_STEP_KEY_INPUT_CHARS) : null;
    if (line) return line;
  }
  return null;
}

export function subagentStepLabel(tool: unknown, keyInput?: string | null): string | null {
  const name = typeof tool === "string" ? firstLine(tool) : null;
  if (!name) return null;
  const detail = keyInput ? scrubbedLine(keyInput, MAX_STEP_KEY_INPUT_CHARS) : null;
  return boundedSubagentLabel(
    detail ? `${name} · ${detail}` : name,
    MAX_SUBAGENT_STEP_LABEL_CHARS,
  );
}

/** What a delegated task is doing now, as one scrubbed line. */
export function subagentActivityLabel(value: unknown): string | null {
  return typeof value === "string" ? scrubbedLine(value, MAX_SUBAGENT_LABEL_CHARS) : null;
}

interface TrackedStep extends SubagentTaskStep {
  id: string | null;
}

/** The most recent tool steps of one delegated agent, oldest first. */
export class SubagentStepRing {
  private readonly steps: TrackedStep[] = [];

  get size(): number {
    return this.steps.length;
  }

  has(id: string): boolean {
    return this.steps.some((step) => step.id === id);
  }

  /** Records a running step; returns whether the visible snapshot changed. */
  start(id: string | null, label: string): boolean {
    const existing = id ? this.steps.find((step) => step.id === id) : undefined;
    if (existing) {
      if (existing.status !== "running" || existing.label === label) return false;
      existing.label = label;
      return true;
    }
    this.steps.push({ id, label, status: "running" });
    while (this.steps.length > MAX_SUBAGENT_STEPS) this.steps.shift();
    return true;
  }

  /** Settles a running step; returns whether the visible snapshot changed. */
  settle(id: string, failed: boolean, label?: string | null): boolean {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (!step || step.status !== "running") return false;
    step.status = failed ? "failed" : "completed";
    if (label) step.label = label;
    return true;
  }

  snapshot(): SubagentTaskStep[] | undefined {
    return this.steps.length > 0
      ? this.steps.map(({ label, status }) => ({ label, status }))
      : undefined;
  }
}
