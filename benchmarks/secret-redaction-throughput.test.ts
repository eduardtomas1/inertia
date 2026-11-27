import { performance } from "node:perf_hooks";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { BoundarySecretRedactor, SecretMatcher } from "../src/server/provider/acp-redaction";
import {
  credentialEncodings,
  sanitizeProviderActivityDetail,
} from "../src/server/provider/activity-detail";
import {
  ClaudeLaunchRedactor,
  claudeKeyedLaunchSecrets,
} from "../src/server/provider/claude-launch-redaction";

const REALISTIC_ANTHROPIC_KEY =
  "sk-ant-api03-Ab3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5mN7pQ9rS1tU3vW5xY7zA9bC1dE3fG5hJ7kL9mN1pQ3rS5tU7vW";

function deltaMessage(index: number, text: string, uuid: string): SDKMessage {
  return {
    type: "stream_event",
    uuid,
    session_id: "88888888-8888-4888-8888-888888888888",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage;
}

describe("secret redaction & activity sanitization throughput", () => {
  it("benchmarks BoundarySecretRedactor, ClaudeLaunchRedactor, and sanitizeProviderActivityDetail", () => {
    // 1. BoundarySecretRedactor: 4,000 x 256-byte chunks with 8 active secrets (normal + adversarial prefix overlap).
    const activeSecrets = [
      "sk-live-secret-alpha-000111222333444",
      "ghp_BravoSecretToken555666777888999000",
      "xoxb-1234567890-charlie-secret-token",
      "tok-delta-99887766554433221100",
      "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb-echo-secret",
      "key_foxtrot_AbCdEfGhIjKlMnOpQrStUvWxYz",
      "Bearer-golf-session-secret-0123456789",
      "hotel-api-secret-xyz9876543210abcdef",
    ];
    const matcher = new SecretMatcher(credentialEncodings(activeSecrets));
    const proseChunk = "Building module src/server/runtime/worker.ts: compiled 42 statements with 0 warnings and 0 errors in 14ms. ".padEnd(256, " ");
    const adversarialChunk = `${"a".repeat(240)}bbbbbbbbbbbbbbbc`.slice(0, 256);

    const proseRedactor = new BoundarySecretRedactor(() => matcher);
    let proseChars = 0;
    const proseStart = performance.now();
    for (let i = 0; i < 4_000; i += 1) {
      proseChars += proseRedactor.push(proseChunk).length;
    }
    proseChars += proseRedactor.finish("significant").length;
    const proseMs = performance.now() - proseStart;

    const advRedactor = new BoundarySecretRedactor(() => matcher);
    let advChars = 0;
    const advStart = performance.now();
    for (let i = 0; i < 4_000; i += 1) {
      advChars += advRedactor.push(adversarialChunk).length;
    }
    advChars += advRedactor.finish("significant").length;
    const advMs = performance.now() - advStart;

    expect(proseChars).toBe(4_000 * 256);
    expect(advChars).toBe(4_000 * 256);

    // 2. ClaudeLaunchRedactor: 4,000 content_block_delta events with a realistic 108-char ANTHROPIC_API_KEY.
    const launchRedactor = new ClaudeLaunchRedactor(
      claudeKeyedLaunchSecrets({ ANTHROPIC_API_KEY: REALISTIC_ANTHROPIC_KEY }),
    );
    const launchMessages = Array.from({ length: 4_000 }, (_, i) =>
      deltaMessage(0, i === 2_000 ? `key=${REALISTIC_ANTHROPIC_KEY} ok ` : "Streaming assistant response chunk without secrets. ", `uuid-${i}`));
    const launchStart = performance.now();
    let emittedLaunch = 0;
    let sawRedacted = false;
    for (const msg of launchMessages) {
      const out = launchRedactor.messages(msg);
      emittedLaunch += out.length;
      const text = (out[0] as { event?: { delta?: { text?: string } } })?.event?.delta?.text ?? "";
      if (text.includes("[redacted]")) sawRedacted = true;
    }
    launchRedactor.finish();
    const launchMs = performance.now() - launchStart;
    expect(emittedLaunch).toBe(4_000);
    expect(sawRedacted).toBe(true);

    // 3. sanitizeProviderActivityDetail: 5,000 command-output lines (64 B - 2 KB).
    const lines = Array.from({ length: 5_000 }, (_, i) => {
      if (i % 50 === 0) {
        return `WARN /home/etomas/project/src/file-${i}.ts line ${i}: finished check with status ok`;
      }
      const repeat = 1 + (i % 16);
      return `PASS test-suite-${i}: verified component rendering and state transitions `.repeat(repeat);
    });
    const sanitizeStart = performance.now();
    let sanitizedCount = 0;
    for (const line of lines) {
      if (sanitizeProviderActivityDetail(line, { workspaceRoot: "/home/etomas/project" })) {
        sanitizedCount += 1;
      }
    }
    const sanitizeMs = performance.now() - sanitizeStart;
    expect(sanitizedCount).toBe(5_000);

    const mb = (4_000 * 256) / (1024 * 1024);
    console.table([
      {
        benchmark: "BoundarySecretRedactor (4000x256B prose, 8 secrets)",
        ms: Number(proseMs.toFixed(2)),
        mbPerSec: Number((mb / (proseMs / 1_000)).toFixed(1)),
      },
      {
        benchmark: "BoundarySecretRedactor (4000x256B adversarial prefix)",
        ms: Number(advMs.toFixed(2)),
        mbPerSec: Number((mb / (advMs / 1_000)).toFixed(1)),
      },
      {
        benchmark: "ClaudeLaunchRedactor (4000 deltas, 108-char key)",
        ms: Number(launchMs.toFixed(2)),
        mbPerSec: null,
      },
      {
        benchmark: "sanitizeProviderActivityDetail (5000 lines)",
        ms: Number(sanitizeMs.toFixed(2)),
        mbPerSec: null,
      },
    ]);
  });
});
