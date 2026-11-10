import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { BoundarySecretRedactor, SecretMatcher } from "../src/server/provider/acp-redaction";
import { credentialEncodings } from "../src/server/provider/activity-detail";
import type { ProviderEvent } from "../src/server/provider/contracts";
import { SecretOutputRedactor } from "../src/server/runtime/agent-secrets/secret-output-redactor";
import { AGENT_SECRET_MAX_LENGTH } from "../src/shared/agent-secrets";

const STREAMS = 64;
const SWEEPS = 3;

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

interface Measurement {
  layout: string;
  tries: number;
  trieNodes: number;
  heapMiB: number;
  openMs: number;
  sweepMs: number;
}

function trieNodes(matcher: SecretMatcher): number {
  let count = 0;
  const pending = [matcher.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    count += 1;
    for (const child of node.children.values()) pending.push(child);
  }
  return count;
}

function heapUsed(): number {
  collect();
  collect();
  return process.memoryUsage().heapUsed;
}

function command(activityId: string, outputDelta: string): ProviderEvent {
  return {
    providerId: "codex", conversationId: "c", runId: "r", turnId: "t",
    type: "activity", kind: "command", phase: "started", label: activityId, activityId, outputDelta,
  };
}

function measurePerStream(secret: string): Measurement {
  const encodings = credentialEncodings([secret]);
  const retained: BoundarySecretRedactor[] = [];
  const matchers: SecretMatcher[] = [];
  const before = heapUsed();
  let started = performance.now();
  for (let index = 0; index < STREAMS; index += 1) {
    const matcher = new SecretMatcher(encodings);
    matchers.push(matcher);
    const boundary = new BoundarySecretRedactor(() => matcher);
    boundary.push(`stream ${index} ${secret.slice(0, 32)}`);
    retained.push(boundary);
  }
  const openMs = performance.now() - started;
  const heapMiB = (heapUsed() - before) / 1024 / 1024;
  started = performance.now();
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    for (let index = 0; index < STREAMS; index += 1) {
      const matcher = new SecretMatcher(encodings);
      matchers[index] = matcher;
      retained[index] = new BoundarySecretRedactor(() => matcher);
      retained[index]!.push("x");
    }
  }
  return {
    layout: "trie per stream, rebuilt each sweep",
    tries: STREAMS,
    trieNodes: trieNodes(matchers[0]!) * STREAMS,
    heapMiB,
    openMs,
    sweepMs: (performance.now() - started) / SWEEPS,
  };
}

function measureShared(secret: string): Measurement & { matcher: readonly string[] } {
  const redactor = new SecretOutputRedactor();
  redactor.setValues([secret]);
  const before = heapUsed();
  let started = performance.now();
  for (let index = 0; index < STREAMS; index += 1) {
    redactor.events(command(`cmd-${index}`, `stream ${index} ${secret.slice(0, 32)}`));
  }
  const openMs = performance.now() - started;
  const heapMiB = (heapUsed() - before) / 1024 / 1024;
  const matcher = redactor.values();
  started = performance.now();
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    redactor.setValues([secret]);
    for (let index = 0; index < STREAMS; index += 1) redactor.events(command(`cmd-${index}`, "x"));
  }
  return {
    layout: "one shared trie per value set",
    tries: 1,
    trieNodes: trieNodes(new SecretMatcher(matcher)),
    heapMiB,
    openMs,
    sweepMs: (performance.now() - started) / SWEEPS,
    matcher,
  };
}

describe("secret redaction matcher cost", () => {
  it(`measures ${STREAMS} output streams over one ${AGENT_SECRET_MAX_LENGTH}-character secret`, () => {
    const secret = randomBytes(AGENT_SECRET_MAX_LENGTH).toString("base64url").slice(0, AGENT_SECRET_MAX_LENGTH);
    const perStream = measurePerStream(secret);
    const shared = measureShared(secret);
    console.table([perStream, shared].map((measurement) => ({
      layout: measurement.layout,
      tries: measurement.tries,
      trieNodes: measurement.trieNodes,
      heapMiB: Number(measurement.heapMiB.toFixed(1)),
      openMs: Number(measurement.openMs.toFixed(1)),
      sweepMs: Number(measurement.sweepMs.toFixed(1)),
    })));
    expect(shared.trieNodes * STREAMS).toBe(perStream.trieNodes);
    expect(shared.matcher).toHaveLength(credentialEncodings([secret]).length);
  });
});
