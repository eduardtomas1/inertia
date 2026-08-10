import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, vi } from "vitest";

export function fakeClaudeChild(
  pid = 4_242,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null],
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  return child;
}

export function writeClaudeSkill(
  root: string,
  name: string,
  body = "Review the repository carefully.",
): string {
  const directory = join(root, ".claude", "skills", name);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(path, [
    "---",
    `name: ${name}`,
    "description: Review the repository.",
    'argument-hint: "<scope>"',
    "---",
    "",
    body,
  ].join("\n"));
  // Match the promise-based realpath used by production discovery. On
  // Windows the legacy synchronous resolver can retain an 8.3 parent alias
  // (for example RUNNER~1) while fs/promises resolves the same file through
  // its long path, which makes an otherwise valid capability look replaced.
  return realpathSync.native(path);
}

export async function waitForImmediateCondition(
  condition: () => boolean,
): Promise<void> {
  const deadlineAt = Date.now() + 2_000;
  while (Date.now() < deadlineAt) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}
