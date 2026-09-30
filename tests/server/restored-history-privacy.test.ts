import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  assembleTurnRequest,
  MAX_EXECUTION_PAYLOAD_BYTES,
} from "../../src/server/runtime/turns/request-context";
import { boundedSubagentText } from "../../src/server/provider/subagent-trace";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { MAX_CONVERSATION_CONTEXT_TURN_BYTES } from "../../src/shared/conversation-context";

const capturedAt = "2030-01-01T00:01:00.000Z";
const stores: RuntimeStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function chat() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-restored-history-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Review", workspace);
  const conversation = store.createConversation(project.id, "Secrets", {
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
  });
  return { store, conversation, workspace };
}

function joined(...parts: string[]): string {
  return parts.join("");
}

function restored(store: RuntimeStore, conversationId: string, capacity = MAX_CONVERSATION_CONTEXT_TURN_BYTES) {
  return store.continuationHistory(conversationId, capacity, capturedAt)!;
}

describe("restored history redaction", () => {
  const anthropicKey = `sk-ant-api03-${"A1b2C3d4".repeat(10)}`;
  const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZXZpZXcifQ.c2lnbmF0dXJlLXZhbHVl";

  it("redacts a fake API key and a bearer token from earlier messages", async () => {
    const { store, conversation } = await chat();
    store.createMessage(conversation.id, `Use ANTHROPIC_API_KEY=${anthropicKey} for the test.`, "user", [], null, "2030-01-01T00:00:00.000Z");
    store.createMessage(conversation.id, `curl -H "Authorization: Bearer ${bearer}" https://api.example.test`, "assistant", [], null, "2030-01-01T00:00:01.000Z");
    store.createMessage(conversation.id, `raw key ${anthropicKey}`, "user", [], null, "2030-01-01T00:00:02.000Z");
    const content = restored(store, conversation.id).blocks.map((block) => block.content).join("\n");
    expect(content).not.toContain(anthropicKey);
    expect(content).not.toContain("A1b2C3d4A1b2C3d4");
    expect(content).not.toContain(bearer);
    expect(content).toContain("[redacted]");
  });

  it.each([
    ["GitHub personal token", `ghp_${"a1B2".repeat(9)}`, "a1B2a1B2a1B2a1B2"],
    ["GitHub OAuth token", `gho_${"c3D4".repeat(9)}`, "c3D4c3D4c3D4c3D4"],
    ["GitHub app token", `ghs_${"e5F6".repeat(9)}`, "e5F6e5F6e5F6e5F6"],
    ["GitHub fine-grained token", `github_pat_11ABCDEFG0_${"g7H8".repeat(12)}`, "g7H8g7H8g7H8g7H8"],
    ["AWS secret", joined("aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"), "wJalrXUtnFEMI/K7MDENG"],
    ["AWS access key id", joined("AKIA", "IOSFODNN7EXAMPLE"), "IOSFODNN7EXAMPLE"],
    ["JSON api_key", `{"api_key": "q9w8e7r6t5y4u3i2o1p0"}`, "q9w8e7r6t5y4u3i2o1p0"],
    ["JSON apiKey", `{"apiKey":"z1x2c3v4b5n6m7"}`, "z1x2c3v4b5n6m7"],
    ["JSON token", `{"token": "t0k3n-v4lue-99"}`, "t0k3n-v4lue-99"],
    ["JSON secret", `{"client_secret": "s3cr3t-v4lue"}`, "s3cr3t-v4lue"],
    ["JSON password", `{"password": "correct horse battery"}`, "correct horse battery"],
    ["URL credentials", "postgres://admin:hunter2-prod-pass@db.internal.example:5432/app", "hunter2-prod-pass"],
    ["PEM private key body", joined("-----BEGIN OPENSSH PRIVATE", " KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE", " KEY-----"), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"],
    ["encrypted PEM body", joined("-----BEGIN RSA PRIVATE", " KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00FF\n\nMIIEpAIBAAKCAQEA7bq9\n-----END RSA PRIVATE", " KEY-----"), "MIIEpAIBAAKCAQEA7bq9"],
    ["Slack bot token", joined("xo", "xb-1234567890-", "abcdefghijklmnop"), "abcdefghijklmnop"],
    ["Slack user token", joined("xo", "xp-1234567890-", "qrstuvwxyzabcd"), "qrstuvwxyzabcd"],
    ["Slack app token", joined("xo", "xa-2-1234567890-", "efghijklmnopqr"), "efghijklmnopqr"],
    ["OpenAI project key", `sk-proj-${"Q1w2E3r4".repeat(6)}`, "Q1w2E3r4Q1w2E3r4"],
  ])("redacts a %s from the automatically restored history", async (_label, secret, probe) => {
    const { store, conversation } = await chat();
    store.createMessage(conversation.id, `Here it is: ${secret}`, "user", [], null, "2030-01-01T00:00:00.000Z");
    store.createMessage(conversation.id, "Thanks.", "assistant", [], null, "2030-01-01T00:00:01.000Z");
    const content = restored(store, conversation.id).blocks.map((block) => block.content).join("\n");
    expect(content).not.toContain(probe);
    expect(content).toContain("[redacted]");
    expect(content).toContain("Here it is:");
  });

  it("keeps ordinary prose, URLs and JSON that carry no secret", async () => {
    const { store, conversation } = await chat();
    const prose = [
      "See https://example.test/docs/setup for the token budget.",
      `{"max_tokens": 1024, "model": "gpt-x", "secretary": "Ada"}`,
      "The password field must accept 64 characters.",
    ].join("\n");
    store.createMessage(conversation.id, prose, "user", [], null, "2030-01-01T00:00:00.000Z");
    store.createMessage(conversation.id, "Thanks.", "assistant", [], null, "2030-01-01T00:00:01.000Z");
    const content = restored(store, conversation.id).blocks.map((block) => block.content).join("\n");
    expect(content).toContain("https://example.test/docs/setup");
    expect(content).toContain("max_tokens");
    expect(content).toContain("Ada");
    expect(content).toContain("The password field must accept 64 characters.");
    expect(content).not.toContain("[redacted]");
  });
});

describe("secret scrubber cost", () => {
  const MIB = 1024 * 1024;
  it.each([
    ["repeated PEM headers without an end", joined("-----BEGIN RSA PRIVATE", " KEY-----\n")],
    ["a PEM header followed by dashes", joined("-----BEGIN PRIVATE", " KEY-----", "-".repeat(40))],
    ["repeated URL schemes with user names", "postgres://admin:"],
    ["repeated URL schemes without a host", "https://"],
    ["unterminated JSON secret values", `{"password": "`],
    ["repeated token prefixes", "ghp_ xoxb- sk- github_pat_ AKIA "],
    ["repeated AWS key names", "aws_secret_access_key = "],
    ["long secret-like runs", `sk-${"a".repeat(4_000)} `],
    ["one PEM header followed by a long body", joined("-----BEGIN PRIVATE", " KEY-----", "A".repeat(MIB))],
    ["JSON-like names ending in a secret word", `"x_y_token": 1, `],
    ["colon-separated words", "a:b:c:d@"],
    ["ordinary prose", "The quick brown fox jumps over the lazy dog. "],
  ])("scrubs 1 MiB of %s in under 100 ms", (_label, unit) => {
    const text = unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB);
    boundedSubagentText(text, 16);
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      boundedSubagentText(text, 16);
      timings.push(performance.now() - started);
    }
    expect(Math.min(...timings)).toBeLessThan(100);
  });
});

describe("restored history attachments", () => {
  it("carries only attachment metadata, never the local path", async () => {
    const { store, conversation, workspace } = await chat();
    const path = join(workspace, "PRIVATE_PATH_SENTINEL", "notes.txt");
    store.createMessage(conversation.id, "See the notes.", "user", [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "notes.txt",
      path,
      mimeType: "text/plain",
      size: 1234,
    }], null, "2030-01-01T00:00:00.000Z");
    store.createMessage(conversation.id, "Read them.", "assistant", [], null, "2030-01-01T00:00:01.000Z");
    const content = restored(store, conversation.id).blocks.map((block) => block.content).join("\n");
    expect(content).toContain("notes.txt");
    expect(content).toContain("1234");
    expect(content).not.toContain("PRIVATE_PATH_SENTINEL");
    expect(content).not.toContain(workspace);
  });
});

describe("restored history hard bound", () => {
  it("never exceeds the execution payload bound and shrinks rather than disappears", async () => {
    const { store, conversation, workspace } = await chat();
    for (let i = 0; i < 80; i += 1) {
      store.createMessage(conversation.id, `message-${i}: ${"🚀\"\\\n".repeat(900)}`, i % 2 === 0 ? "user" : "assistant", [], null, new Date(Date.UTC(2030, 0, 2, 0, 0, i)).toISOString());
    }
    const outcomes: Array<{ selected: number; bytes: number; restored: number }> = [];
    for (let selected = 0; selected <= 200_000; selected += 8_000) {
      const perTerminal = Math.floor(selected / 4);
      const assembled = assembleTurnRequest({
        cwd: workspace,
        visibleContent: "Continue.",
        context: {
          terminalContexts: perTerminal > 0
            ? Array.from({ length: 4 }, (_, i) => ({ terminalId: `t-${i}`, terminalLabel: "Logs", lineStart: 1, lineEnd: 1, content: "é".repeat(Math.floor(perTerminal / 2)) }))
            : [],
        },
        restoredHistory: (capacity) => store.continuationHistory(conversation.id, capacity, capturedAt),
      });
      const bytes = Buffer.byteLength(assembled.executionPrompt, "utf8");
      expect(bytes).toBeLessThanOrEqual(MAX_EXECUTION_PAYLOAD_BYTES);
      expect(assembled.persistence.manifest.assembledPayloadBytes).toBe(bytes);
      outcomes.push({ selected, bytes, restored: assembled.sessionRecovery?.restoredMessageCount ?? -1 });
    }
    const dropped = outcomes.filter(({ selected, restored: count }) => count === 0 && selected < 190_000);
    expect(dropped).toEqual([]);
  });
});
