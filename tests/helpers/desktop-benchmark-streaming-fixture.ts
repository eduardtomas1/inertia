import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const STREAMING_COMPLETION_GATE_TIMEOUT_MS = 15_000;
const STREAMING_COMPLETION_GATE_POLL_MS = 10;

export function streamingCompletionGatePaths(
  workspace: string,
  sampleNumber: number,
): {
  reader: string;
  readerActive: string;
  ready: string;
  release: string;
} {
  if (!Number.isInteger(sampleNumber) || sampleNumber <= 0) {
    throw new Error("Streaming sample numbers must be positive integers.");
  }
  const prefix = `.inertia-stream-completion-${sampleNumber}`;
  return {
    reader: join(workspace, `${prefix}.reader`),
    readerActive: join(workspace, `${prefix}.reader-active`),
    ready: join(workspace, `${prefix}.ready`),
    release: join(workspace, `${prefix}.release`),
  };
}

export async function cleanupStreamingCompletionGate(
  workspace: string,
  sampleNumber: number,
): Promise<void> {
  const paths = streamingCompletionGatePaths(workspace, sampleNumber);
  await Promise.all([
    rm(paths.reader, { force: true }),
    rm(paths.readerActive, { force: true }),
    rm(paths.ready, { force: true }),
    rm(paths.release, { force: true }),
  ]);
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await access(path).then(() => true, () => false)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for benchmark gate path ${path}.`);
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, STREAMING_COMPLETION_GATE_POLL_MS);
    });
  }
}

export async function waitForStreamingCompletionReady(
  workspace: string,
  sampleNumber: number,
  timeoutMs = STREAMING_COMPLETION_GATE_TIMEOUT_MS,
): Promise<void> {
  const { ready } = streamingCompletionGatePaths(workspace, sampleNumber);
  await waitForPath(ready, timeoutMs);
}

export async function releaseStreamingCompletion(
  workspace: string,
  sampleNumber: number,
): Promise<void> {
  const { release } = streamingCompletionGatePaths(workspace, sampleNumber);
  await writeFile(release, "release\n", { encoding: "utf8", flag: "wx" });
}

export async function beginStreamingReaderActivity(
  workspace: string,
  sampleNumber: number,
): Promise<void> {
  const { reader } = streamingCompletionGatePaths(workspace, sampleNumber);
  await writeFile(reader, "reader\n", { encoding: "utf8", flag: "wx" });
}

export async function waitForStreamingReaderActivity(
  workspace: string,
  sampleNumber: number,
  timeoutMs = STREAMING_COMPLETION_GATE_TIMEOUT_MS,
): Promise<void> {
  const { readerActive } = streamingCompletionGatePaths(workspace, sampleNumber);
  await waitForPath(readerActive, timeoutMs);
}

export async function waitForStreamingCompletionCleanup(
  workspace: string,
  sampleNumber: number,
  timeoutMs = STREAMING_COMPLETION_GATE_TIMEOUT_MS,
): Promise<void> {
  const paths = streamingCompletionGatePaths(workspace, sampleNumber);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const present = await Promise.all(Object.values(paths).map(
      (path) => access(path).then(() => true, () => false),
    ));
    if (present.every((value) => !value)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for benchmark gate cleanup for sample ${sampleNumber}.`);
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, STREAMING_COMPLETION_GATE_POLL_MS);
    });
  }
}

export const streamingAppServer = `
const { existsSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const boundedSetting = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
};
const streamIntervalMs = boundedSetting(
  "INERTIA_BENCHMARK_STREAM_INTERVAL_MS",
  8,
  1,
  100,
);
const completionGateTimeoutMs = boundedSetting(
  "INERTIA_BENCHMARK_COMPLETION_GATE_TIMEOUT_MS",
  ${STREAMING_COMPLETION_GATE_TIMEOUT_MS},
  10,
  60_000,
);
const gatePaths = (sampleNumber) => {
  const prefix = ".inertia-stream-completion-" + sampleNumber;
  return {
    reader: join(process.cwd(), prefix + ".reader"),
    readerActive: join(process.cwd(), prefix + ".reader-active"),
    ready: join(process.cwd(), prefix + ".ready"),
    release: join(process.cwd(), prefix + ".release"),
  };
};
const cleanupGate = ({ reader, readerActive, ready, release }) => {
  rmSync(reader, { force: true });
  rmSync(readerActive, { force: true });
  rmSync(ready, { force: true });
  rmSync(release, { force: true });
};
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "performance-thread";
let turnSequence = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "performance-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const promptText = Array.isArray(message.params && message.params.input)
    ? message.params.input.find((item) => item && item.type === "text")?.text || ""
    : "";
  const requestedSample = Number(/sample (\\d+)/u.exec(promptText)?.[1]);
  const sampleNumber = Number.isInteger(requestedSample) && requestedSample > 0
    ? requestedSample
    : turnSequence;
  const turnId = "performance-turn-" + sampleNumber;
  const itemId = "performance-answer-" + sampleNumber;
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  let index = 0;
  const timer = setInterval(() => {
    if (index === 0) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: "STREAM_PROVIDER_DELTA_" + sampleNumber + "_" + Date.now() + " " } });
    } else if (index < 128) {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: "chunk-" + index + "🙂 " } });
    } else {
      clearInterval(timer);
      const paths = gatePaths(sampleNumber);
      cleanupGate(paths);
      writeFileSync(paths.ready, "ready\\n", { encoding: "utf8", flag: "wx" });
      const gateStartedAt = Date.now();
      let readerChunk = 0;
      const gateTimer = setInterval(() => {
        if (existsSync(paths.release)) {
          clearInterval(gateTimer);
          cleanupGate(paths);
          send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: " STREAM_PROVIDER_COMPLETE_" + sampleNumber + "_" + Date.now() } });
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
          return;
        }
        if (existsSync(paths.reader)) {
          readerChunk += 1;
          if (readerChunk === 1) {
            writeFileSync(paths.readerActive, "active\\n", {
              encoding: "utf8",
              flag: "wx",
            });
          }
          send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: " STREAM_PROVIDER_READER_ACTIVITY_" + sampleNumber + "_" + readerChunk + " " } });
        }
        if (Date.now() - gateStartedAt >= completionGateTimeoutMs) {
          clearInterval(gateTimer);
          cleanupGate(paths);
          process.stderr.write("Benchmark completion gate timed out.\\n");
          process.exit(2);
        }
      }, Math.min(10, streamIntervalMs));
    }
    index += 1;
  }, streamIntervalMs);
});
`;
