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
  return realpathSync(path);
}

export async function waitForImmediateCondition(
  condition: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(condition()).toBe(true);
}
