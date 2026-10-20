import { describe, expect, it } from "vitest";

import type { ProviderEvent, ProviderRunResult } from "../../src/server/provider/contracts";
import { redactHostToolPayload } from "../../src/server/provider/host-tool-redaction";
import { RUN_SECRET_MARKER, RunSecretRedactor } from "../../src/server/provider/run-secret-redaction";

const SECRET = "mcp-secret-7f3a91c2";
const base = { providerId: "codex" as const, conversationId: "chat-1", runId: "run-1", turnId: "turn-1" };

function text(value: string, itemId?: string): ProviderEvent {
  return { ...base, type: "text", text: value, ...(itemId ? { itemId } : {}) };
}

function reasoning(value: string): ProviderEvent {
  return { ...base, type: "reasoning-summary", text: value };
}

/** The text a projector would assemble from the delivered events of one stream. */
function streamed(events: readonly ProviderEvent[], type: "text" | "reasoning-summary"): string {
  return events.filter((event) => event.type === type).map((event) => (event as { text: string }).text).join("");
}

function play(redactor: RunSecretRedactor, events: readonly ProviderEvent[]): ProviderEvent[] {
  return [...events.flatMap((event) => redactor.event(event)), ...redactor.flush()];
}

describe("run secret redaction", () => {
  it.each([
    ["two", [`Use ${SECRET.slice(0, 7)}`, `${SECRET.slice(7)} now.`]],
    ["three", ["Use mcp-", "secret-7f", "3a91c2 now."]],
    ["one character at a time", [..."Use ", ...SECRET, ..." now."]],
  ])("replaces a secret split across %s assistant deltas", (_label, deltas) => {
    const delivered = play(new RunSecretRedactor([SECRET]), deltas.map((delta) => text(delta, "answer")));
    expect(streamed(delivered, "text")).toBe(`Use ${RUN_SECRET_MARKER} now.`);
    expect(JSON.stringify(delivered)).not.toContain(SECRET);
    // No delivered delta carries even a large piece of it.
    for (const event of delivered) expect(JSON.stringify(event)).not.toContain(SECRET.slice(0, 8));
  });

  it("replaces a secret split across reasoning deltas", () => {
    const delivered = play(new RunSecretRedactor([SECRET]), ["Header holds mcp-sec", "ret-7f3a9", "1c2."].map(reasoning));
    expect(streamed(delivered, "reasoning-summary")).toBe(`Header holds ${RUN_SECRET_MARKER}.`);
  });

  it("releases held text at text boundaries, in order, and replaces a significant fragment", () => {
    const redactor = new RunSecretRedactor([SECRET]);
    // "mcp-sec" could still become the secret, so it is held back...
    expect(redactor.event(text("Token: mcp-sec", "a"))).toEqual([text("Token: ", "a")]);
    // ...until an activity closes the segment: a large fragment is not released.
    const boundary: ProviderEvent = { ...base, type: "activity", kind: "tool", phase: "started", label: "Tool" };
    expect(redactor.event(boundary)).toEqual([text(RUN_SECRET_MARKER, "a"), boundary]);
    // A short, common prefix is released as it is.
    expect(redactor.event(text("I use mc", "b"))).toEqual([text("I use ", "b")]);
    expect(redactor.event({ ...base, type: "text-boundary" })).toEqual([text("mc", "b"), { ...base, type: "text-boundary" }]);
    // A new item releases the previous item's held text first, under its own id.
    expect(redactor.event(text("x mcp", "c"))).toEqual([text("x ", "c")]);
    expect(redactor.event(text("Next", "d"))).toEqual([text("mcp", "c"), text("Next", "d")]);
    expect(redactor.flush()).toEqual([]);
  });

  it("rewrites only text-bearing fields, never identities, keys or enumerations", () => {
    const idSecret = "id-part-1234";
    const redactor = new RunSecretRedactor([idSecret]);
    const ids = { ...base, conversationId: `c-${idSecret}`, runId: `r-${idSecret}`, turnId: `t-${idSecret}` };
    const events: ProviderEvent[] = [
      { ...ids, type: "session", sessionId: `s-${idSecret}` },
      { ...ids, type: "activity", kind: "tool", phase: "started", label: `L ${idSecret}`, activityId: `a-${idSecret}`, detail: `D ${idSecret}`, outputDelta: `O ${idSecret}` },
      { ...ids, type: "approval", request: {
        requestId: `q-${idSecret}`, kind: "command", title: `T ${idSecret}`, command: `run ${idSecret}`, cwd: `/w/${idSecret}`,
        reason: `R ${idSecret}`, permissionRoots: [{ path: `/w/${idSecret}`, access: "write" }], availableDecisions: ["approve", "deny"],
      } },
      { ...ids, type: "approval-resolved", requestId: `q-${idSecret}`, decision: "approve" },
      { ...ids, type: "input", request: { requestId: `i-${idSecret}`, autoResolutionMs: null, questions: [{
        id: `qq-${idSecret}`, header: `H ${idSecret}`, question: `Q ${idSecret}`, isOther: false, isSecret: false, allowMultiple: false,
        options: [{ id: `o-${idSecret}`, label: `L ${idSecret}`, description: `D ${idSecret}` }],
      }] } },
      { ...ids, type: "input-resolved", requestId: `i-${idSecret}` },
      { ...ids, type: "plan", explanation: `E ${idSecret}`, steps: [{ step: `S ${idSecret}`, status: "pending" }] },
      { ...ids, type: "text-snapshot", itemId: `item-${idSecret}`, text: `Snap ${idSecret}` },
      { ...ids, type: "status", status: "running", message: `M ${idSecret}` },
    ];
    const delivered = events.flatMap((event) => redactor.event(event));
    expect(delivered).toHaveLength(events.length);
    for (const event of delivered) {
      expect(event).toMatchObject({ conversationId: `c-${idSecret}`, runId: `r-${idSecret}`, turnId: `t-${idSecret}` });
    }
    const json = JSON.stringify(delivered);
    for (const id of ["s-", "a-", "q-", "i-", "qq-", "o-", "item-"]) expect(json).toContain(`"${id}${idSecret}"`);
    // Paths are structural and stay exact; prose is redacted.
    expect(json).toContain(`/w/${idSecret}`);
    for (const prose of ["L ", "D ", "O ", "T ", "run ", "R ", "H ", "Q ", "E ", "S ", "Snap ", "M "]) {
      expect(json, prose).not.toContain(`${prose}${idSecret}`);
      expect(json, prose).toContain(`${prose}${RUN_SECRET_MARKER}`);
    }
    // The result keeps its identity and session too.
    const result: ProviderRunResult = {
      ...ids, status: "completed", terminalReason: { outcome: "completed", reason: "provider-completed" },
      sessionId: `s-${idSecret}`, text: `Done ${idSecret}`, textTruncated: false, exitCode: 0, signal: null, cleanupConfirmed: true,
    };
    expect(redactor.result(result)).toEqual({ ...result, text: `Done ${RUN_SECRET_MARKER}` });
  });

  it("never makes a value longer, so output limits still hold", () => {
    const redactor = new RunSecretRedactor(["12345678", "Bearer 12345678"]);
    for (const value of ["12345678", "Bearer 12345678", "a12345678b".repeat(1_000), "x"]) {
      expect(redactor.text(value).length).toBeLessThanOrEqual(value.length);
    }
    expect(RUN_SECRET_MARKER).toHaveLength(8);
  });

  it("ignores values too short to redact safely and is inert without secrets", () => {
    const redactor = new RunSecretRedactor(["", "a", "1234567"]);
    expect(redactor.active).toBe(false);
    const event = text("a 1234567 run-1", "x");
    expect(redactor.event(event)).toEqual([event]);
    expect(redactor.text("a 1234567")).toBe("a 1234567");
  });

  it("redacts an error's message and stack", () => {
    const error = new Error(`failed: ${SECRET}`);
    error.stack = `Error: failed: ${SECRET}\n    at x (${SECRET}:1:1)`;
    new RunSecretRedactor([SECRET]).error(error);
    expect(error.message).toBe(`failed: ${RUN_SECRET_MARKER}`);
    expect(error.stack).not.toContain(SECRET);
  });
});

describe("host bridge payload redaction", () => {
  it("rewrites string values but never object keys", () => {
    const token = "bridge-token-0123456789abcdef";
    const payload = { [token]: `value ${token}`, nested: { list: [token], keep: 1 } };
    expect(redactHostToolPayload(payload, [token])).toEqual({
      [token]: "value [redacted]",
      nested: { list: ["[redacted]"], keep: 1 },
    });
  });
});
