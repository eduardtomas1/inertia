import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BoundedProcessExitError,
  BoundedProcessTimeoutError,
  ProcessTreeCleanupError,
  runBounded,
} from "../bounded-process-tree.mjs";

const MAX_ITERATIONS = 5;
const ATTEMPT_TIMEOUT_MS = 6 * 60_000;
const MAX_ATTEMPT_OUTPUT_BYTES = 4 * 1024 * 1024;
const COMMON_SUITES = [
  "tests/main/app-update-handoff.test.ts",
  "tests/main/runtime-supervisor-lifecycle.test.ts",
  "tests/server/process-lifecycle.test.ts",
  "tests/server/runtime-shutdown-authority.test.ts",
];
const PLATFORM_SUITES = {
  darwin: [
    "tests/main/runtime-live-darwin-recovery.test.ts",
    "tests/main/runtime-owned-process-darwin-helper.test.ts",
    "tests/main/terminal-darwin-shutdown.test.ts",
  ],
  linux: [
    "tests/main/app-update-startup.test.ts",
    "tests/main/appimage-installed-identity.test.ts",
    "tests/main/runtime-recovery-integration.test.ts",
  ],
  win32: [
    "tests/main/electron-app-updater.test.ts",
    "tests/main/runtime-supervisor-windows-tree-recovery.test.ts",
    "tests/main/windows-runtime-job.test.ts",
  ],
};

export function repeatedLifecycleSuites(platform) {
  const platformSuites = PLATFORM_SUITES[platform];
  if (!platformSuites) {
    throw new Error("Repeated lifecycle certification does not support this platform.");
  }
  return Object.freeze([...COMMON_SUITES, ...platformSuites]);
}

function parseOptions(arguments_) {
  if (arguments_.length !== 4) {
    throw new Error("Expected --iterations and --output-directory exactly once.");
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (name !== "--iterations" && name !== "--output-directory")
      || values.has(name)
      || !value
      || value.startsWith("--")
    ) throw new Error("The repeated lifecycle options are invalid.");
    values.set(name, value);
  }
  const iterations = Number(values.get("--iterations"));
  if (
    !Number.isSafeInteger(iterations)
    || iterations < 2
    || iterations > MAX_ITERATIONS
  ) throw new Error("Repeated lifecycle iterations must be between 2 and 5.");
  return {
    iterations,
    outputDirectory: resolve(values.get("--output-directory")),
  };
}

export async function runLifecycleAttempt({
  args,
  command,
  label,
  outputPath,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
}) {
  if (
    typeof command !== "string"
    || command.length === 0
    || !Array.isArray(args)
    || args.some((value) => typeof value !== "string")
    || typeof label !== "string"
    || label.length === 0
    || typeof outputPath !== "string"
    || outputPath.length === 0
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > ATTEMPT_TIMEOUT_MS
  ) throw new Error("The lifecycle attempt configuration is invalid.");
  const startedAt = Date.now();
  const output = createWriteStream(outputPath, {
    encoding: "utf8",
    flags: "wx",
    mode: 0o600,
  });
  await once(output, "open");
  const outputClosed = new Promise((settle) => {
    output.once("close", settle);
  });
  const abortController = new AbortController();
  let outputError = null;
  output.once("error", (error) => {
    outputError = error;
    abortController.abort();
  });
  let result;
  try {
    await runBounded(command, args, {
      echoOutputLive: true,
      env: { ...process.env, FORCE_COLOR: "0" },
      label,
      maxOutputBytes: MAX_ATTEMPT_OUTPUT_BYTES,
      onSpawn: ({ pid, processGroupId }) => {
        output.write(`${JSON.stringify({
          schemaVersion: 1,
          event: "attempt-started",
          owner: { pid, processGroupId },
        })}\n`);
      },
      onOutput: (_stream, chunk) => {
        output.write(chunk);
      },
      signal: abortController.signal,
      timeoutMs,
    });
    result = {
      passed: true,
      exitCode: 0,
      signal: null,
      outcome: "passed",
    };
  } catch (error) {
    const outcome = error instanceof ProcessTreeCleanupError
      ? "cleanup-unconfirmed"
      : error instanceof BoundedProcessTimeoutError
        ? "timed-out"
        : "failed";
    result = {
      passed: false,
      exitCode: error instanceof BoundedProcessExitError
        ? error.exitCode
        : null,
      signal: error instanceof BoundedProcessExitError
        ? error.signal
        : null,
      outcome,
    };
    output.write(
      `\nLifecycle attempt terminal outcome: ${outcome}.\n`
      + `${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    output.end();
    await outputClosed;
  }
  if (outputError) throw outputError;
  return Object.freeze({
    ...result,
    durationMs: Date.now() - startedAt,
  });
}

async function runAttempt(suites, outputPath, index) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return await runLifecycleAttempt({
    args: [
      "exec",
      "--",
      "vitest",
      "run",
      "--maxWorkers=1",
      ...suites,
    ],
    command,
    label: `Lifecycle repetition ${index}`,
    outputPath,
  });
}

export function repeatedLifecycleClassification(attempts) {
  const passes = attempts.filter(({ passed }) => passed).length;
  if (passes === attempts.length) return "stable-pass";
  if (passes === 0) return "stable-failure";
  return "flake-observed";
}

export async function main(arguments_ = process.argv.slice(2)) {
  const options = parseOptions(arguments_);
  const suites = repeatedLifecycleSuites(process.platform);
  await mkdir(options.outputDirectory, { recursive: true });
  const attempts = [];
  for (let index = 1; index <= options.iterations; index += 1) {
    const outputPath = resolve(
      options.outputDirectory,
      `attempt-${String(index).padStart(2, "0")}.log`,
    );
    console.log(`Lifecycle repetition ${index}/${options.iterations}.`);
    const attempt = await runAttempt(suites, outputPath, index);
    attempts.push(attempt);
    if (attempt.outcome === "cleanup-unconfirmed") break;
  }
  const classification = repeatedLifecycleClassification(attempts);
  const summary = {
    schemaVersion: 1,
    commitSha: process.env.GITHUB_SHA ?? null,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    classification,
    suites,
    attempts,
  };
  await writeFile(
    resolve(options.outputDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  console.log(`Repeated lifecycle classification: ${classification}.`);
  if (classification !== "stable-pass") process.exitCode = 1;
  return summary;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
