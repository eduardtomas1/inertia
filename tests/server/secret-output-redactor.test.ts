import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretMatcher } from "../../src/server/provider/acp-redaction";
import { boundProviderActivityDetail } from "../../src/server/provider/activity-detail";
import type { ProviderEvent, ProviderRunResult } from "../../src/server/provider/contracts";
import { SecretOutputRedactor } from "../../src/server/runtime/agent-secrets/secret-output-redactor";

const SECRET = "fake-token-kQ9xZ2mB7vN4pL1sR8tW";
const BASE = { providerId: "codex", conversationId: "c", runId: "r", turnId: "t" } as const;

function text(value: string, turnId = "t"): ProviderEvent {
  return { ...BASE, turnId, type: "text", text: value, itemId: "item-1" };
}

function streamed(events: readonly ProviderEvent[]): string {
  return events.map((event) => (event.type === "text" ? event.text : "")).join("");
}

function redactor(values: readonly string[] = [SECRET]): SecretOutputRedactor {
  const value = new SecretOutputRedactor();
  value.setValues(values);
  return value;
}

describe("secret output redactor: active values never leave the turn controller choke point", () => {
  it("returns the same event and result objects while no secret is active", () => {
    const empty = new SecretOutputRedactor();
    const event = text(`token ${SECRET}`);
    expect(empty.events(event)).toEqual([event]);
    expect(empty.events(event)[0]).toBe(event);
    const activity: ProviderEvent = { ...BASE, type: "activity", kind: "command", phase: "info", label: "cat", outputDelta: SECRET };
    expect(empty.events(activity)[0]).toBe(activity);
    const result = { ...BASE, status: "completed", text: SECRET } as ProviderRunResult;
    expect(empty.result(result)).toEqual({ events: [], result });
    expect(empty.result(result).result).toBe(result);
  });

  it("redacts a value split across streamed text chunks and flushes the held tail on the next event", () => {
    const value = redactor();
    const output = [
      ...value.events(text("Your key is fake-token-")),
      ...value.events(text("kQ9xZ2mB7vN4")),
      ...value.events(text("pL1sR8tW and it works. tsk")),
      ...value.events({ ...BASE, type: "text-boundary" }),
    ];
    expect(streamed(output)).toBe("Your key is [redacted] and it works. tsk");
    expect(JSON.stringify(output)).not.toContain(SECRET);
    expect(output.at(-1)).toMatchObject({ type: "text-boundary" });
    const fresh = value.events(text("plain"));
    expect(streamed(fresh)).toBe("plain");
  });

  it("keeps per-turn stream state apart", () => {
    const value = redactor();
    const output = [
      ...value.events(text("a fake-token-kQ9", "t")),
      ...value.events(text("other turn text.", "u")),
      ...value.events(text("xZ2mB7vN4pL1sR8tW b", "t")),
    ];
    expect(streamed(output.filter(({ turnId }) => turnId === "t")) + streamed(value.result({ ...BASE, status: "completed", text: "" } as ProviderRunResult).events))
      .toBe("a [redacted] b");
    expect(streamed(output.filter(({ turnId }) => turnId === "u"))).toBe("other turn text.");
  });

  it("redacts command output, labels, details, snapshots, reasoning and subagent traces, including encodings and ANSI splits", () => {
    const value = redactor();
    const base64 = Buffer.from(SECRET).toString("base64");
    const events: ProviderEvent[] = [
      { ...BASE, type: "activity", kind: "command", phase: "info", label: `cat ${SECRET}`, detail: `echo ${encodeURIComponent(SECRET)}`, outputDelta: `${SECRET.slice(0, 10)}\u001b[31m${SECRET.slice(10)}\u001b[0m\n` },
      { ...BASE, type: "activity", kind: "tool", phase: "completed", label: "tool", outputDelta: `{"token":"${base64}"}` },
      { ...BASE, type: "text-snapshot", itemId: "item-1", text: `Snapshot ${SECRET}` },
      { ...BASE, type: "reasoning-summary", text: `Thinking about ${JSON.stringify(SECRET).slice(1, -1)}` },
      {
        ...BASE, type: "subagent", sequence: 1, providerTaskId: "task", providerAgentId: null, parentProviderAgentId: null,
        parentProviderToolUseId: null, providerToolUseId: null, providerRole: null, providerName: null,
        status: "completed", isLive: false, description: "Use the key", progress: null, result: `Logged in with ${SECRET}`,
      },
      { ...BASE, type: "approval", request: { requestId: "a", kind: "command", title: `Run with ${SECRET}`, availableDecisions: ["approve"], permissionRoots: [] } as never },
    ];
    const output = events.flatMap((event) => value.events(event));
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(base64);
    expect(serialized).not.toContain(encodeURIComponent(SECRET).slice(0, 20));
    expect(serialized).not.toContain(SECRET.slice(10));
    expect(output[0]).toMatchObject({ label: "cat [redacted]", detail: "echo [redacted]" });
    expect((output[0] as { outputDelta: string }).outputDelta).toContain("[redacted]");
    expect(output[2]).toMatchObject({ text: "Snapshot [redacted]" });
    expect(output[4]).toMatchObject({ result: "Logged in with [redacted]" });
  });

  it("redacts the pieces of a value that a bounded detail cut at its omission marker", () => {
    const value = redactor();
    const limit = 400;
    const probe = boundProviderActivityDetail("x".repeat(800), limit);
    const headLength = probe.indexOf("\n…");
    const tailLength = limit - probe.lastIndexOf("…\n") - 2;
    const source = `${"a".repeat(headLength - 12)}${SECRET}${"b".repeat(800 - headLength - tailLength - 28)}${SECRET}${"c".repeat(tailLength - SECRET.length + 9)}`;
    const detail = boundProviderActivityDetail(source, limit);
    const marker = detail.slice(detail.indexOf("\n…"), detail.lastIndexOf("…\n") + 2);
    expect(source.length).toBe(800);
    expect(detail).toContain(SECRET.slice(0, 12));
    expect(detail).toContain(SECRET.slice(-(SECRET.length - 9)));
    const emitted = [
      ...value.events({ ...BASE, type: "activity", kind: "command", phase: "completed", label: "curl", activityId: "cmd-1", detail }),
      ...value.events({ ...BASE, type: "activity", kind: "command", phase: "started", label: "curl", activityId: "cmd-2", outputDelta: detail }),
      ...value.events({ ...BASE, type: "activity", kind: "command", phase: "completed", label: "curl", activityId: "cmd-2" }),
    ];
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain(SECRET.slice(0, 12));
    expect(serialized).not.toContain(SECRET.slice(-(SECRET.length - 9)));
    expect(emitted[0]).toMatchObject({ detail: `${"a".repeat(headLength - 12)}[redacted]${marker}[redacted]${"c".repeat(tailLength - SECRET.length + 9)}` });
    expect(value.text(`plain${marker}text`)).toBe(`plain${marker}text`);
  });

  it("redacts the final result text and failure detail, keeps the cleanup promise, and flushes held text first", () => {
    const value = redactor();
    expect(streamed(value.events(text("Done with fake-token-kQ9xZ2")))).toBe("Done with ");
    const cleanupConfirmation = Promise.resolve(true);
    const result = {
      ...BASE, status: "failed", text: `Done with ${SECRET}`, textTruncated: false, exitCode: 1, signal: null,
      error: `exit: ${SECRET}`, failure: { reason: "provider-error", message: `failed ${SECRET}` },
      cleanupConfirmed: true, cleanupConfirmation, terminalReason: { outcome: "failed", reason: "provider-error" },
    } as unknown as ProviderRunResult;
    const output = value.result(result);
    expect(streamed(output.events)).toBe("[redacted]");
    expect(output.result.text).toBe("Done with [redacted]");
    expect(output.result.error).toBe("exit: [redacted]");
    expect(output.result.failure?.message).toBe("failed [redacted]");
    expect(output.result.cleanupConfirmation).toBe(cleanupConfirmation);
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  it("stops redacting a value once it is no longer active", () => {
    const value = redactor();
    expect(value.text(`x ${SECRET}`)).toBe("x [redacted]");
    value.setValues([]);
    expect(value.text(`x ${SECRET}`)).toBe(`x ${SECRET}`);
    expect(value.active()).toBe(false);
  });

  it("holds a value split across one command's output deltas until it can be matched whole", () => {
    const value = redactor();
    const output = (delta: string, phase: "started" | "completed" = "started"): ProviderEvent => ({
      ...BASE, type: "activity", kind: "command", phase, label: "cat key", activityId: "cmd-1", outputDelta: delta,
    });
    const emitted = [
      ...value.events(output("key=fake-token-kQ")),
      ...value.events(output("9xZ2mB7vN4")),
      ...value.events({ ...BASE, type: "usage", usage: {} as never }),
      ...value.events(output("pL1sR8tW\nok\n", "completed")),
    ];
    const joined = emitted.map((event) => (event.type === "activity" ? event.outputDelta ?? "" : "")).join("");
    expect(joined).toBe("key=[redacted]\nok\n");
    expect(JSON.stringify(emitted)).not.toContain(SECRET);
    expect(emitted.at(-1)).toMatchObject({ phase: "completed", activityId: "cmd-1" });
  });

  it("keeps two commands' output streams apart and flushes an unfinished one at the turn result", () => {
    const value = redactor();
    const emitted = [
      ...value.events({ ...BASE, type: "activity", kind: "command", phase: "started", label: "a", activityId: "a", outputDelta: "A fake-token-" }),
      ...value.events({ ...BASE, type: "activity", kind: "command", phase: "started", label: "b", activityId: "b", outputDelta: "B kQ9xZ2mB7vN4pL1sR8tW" }),
      ...value.events({ ...BASE, type: "activity", kind: "command", phase: "started", label: "a", activityId: "a", outputDelta: "kQ9xZ2mB7vN4pL1sR8tW done" }),
    ];
    const finished = value.result({ ...BASE, status: "completed", text: "" } as ProviderRunResult);
    const byActivity = (id: string) => [...emitted, ...finished.events]
      .map((event) => (event.type === "activity" && event.activityId === id ? event.outputDelta ?? "" : "")).join("");
    expect(byActivity("a")).toBe("A [redacted] done");
    expect(byActivity("b")).toBe("B kQ9xZ2mB7vN4pL1sR8tW");
    const prefix = SECRET.slice(0, 5);
    const tail = value.events({ ...BASE, type: "activity", kind: "command", phase: "started", label: "c", activityId: "c", outputDelta: `C ${prefix}` });
    const flushed = value.result({ ...BASE, status: "completed", text: "" } as ProviderRunResult).events;
    expect(tail).toEqual([expect.objectContaining({ activityId: "c" })]);
    expect(tail[0]).not.toHaveProperty("outputDelta", `C ${prefix}`);
    expect(flushed).toEqual([expect.objectContaining({ type: "activity", phase: "started", activityId: "c", outputDelta: prefix })]);
  });

  it("redacts reasoning split across deltas even when other events interleave", () => {
    const value = redactor();
    const reasoning = (text: string): ProviderEvent => ({ ...BASE, type: "reasoning-summary", text });
    const emitted = [
      ...value.events(reasoning("Using fake-token-kQ9x")),
      ...value.events({ ...BASE, type: "activity", kind: "tool", phase: "started", label: "tool" }),
      ...value.events(reasoning("Z2mB7vN4pL1sR8tW now.")),
    ];
    const text = [...emitted, ...value.result({ ...BASE, status: "completed", text: "" } as ProviderRunResult).events]
      .map((event) => (event.type === "reasoning-summary" ? event.text : "")).join("");
    expect(text).toBe("Using [redacted] now.");
  });

  it("does not release a held assistant prefix on events that leave the segment open", () => {
    const value = redactor();
    const emitted = [
      ...value.events(text(`key ${SECRET.slice(0, 3)}`)),
      ...value.events({ ...BASE, type: "usage", usage: {} as never }),
      ...value.events({ ...BASE, type: "status", status: "running" }),
      ...value.events(text(`${SECRET.slice(3)} end`)),
      ...value.events({ ...BASE, type: "text-boundary" }),
    ];
    expect(streamed(emitted)).toBe("key [redacted] end");
  });

  it("retains at most the longest active encoding per stream and drops held text at turn teardown", () => {
    const value = redactor();
    const longest = Math.max(...value.values().map((encoding) => encoding.length));
    let sent = 0;
    let released = 0;
    for (let index = 0; index < 50; index += 1) {
      const chunk = `${"x".repeat(97)}${SECRET.slice(0, 20)}`;
      sent += chunk.length;
      released += streamed(value.events(text(chunk))).length;
      expect(sent - released).toBeGreaterThan(0);
      expect(sent - released).toBeLessThanOrEqual(longest);
    }
    value.discard("t");
    expect(value.result({ ...BASE, status: "completed", text: "" } as ProviderRunResult).events).toEqual([]);
    expect(streamed(value.events(text("plain")))).toBe("plain");
  });
});

describe("secret output redactor: one matcher per active value set", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function trackRoots(): Set<unknown> {
    const roots = new Set<unknown>();
    const getter = Object.getOwnPropertyDescriptor(SecretMatcher.prototype, "root")!.get!;
    vi.spyOn(SecretMatcher.prototype, "root", "get").mockImplementation(function (this: SecretMatcher) {
      const root: SecretMatcher["root"] = getter.call(this);
      roots.add(root);
      return root;
    });
    return roots;
  }

  function command(activityId: string, outputDelta: string, turnId = "t"): ProviderEvent {
    return { ...BASE, turnId, type: "activity", kind: "command", phase: "started", label: activityId, activityId, outputDelta };
  }

  it("shares one trie across every stream and turn until the active values change", () => {
    const value = redactor();
    const roots = trackRoots();
    const emitted = [
      ...value.events(text("a fake-token-", "t")),
      ...value.events(text("b fake-token-", "u")),
      ...value.events({ ...BASE, type: "reasoning-summary", text: "r fake-token-" }),
      ...Array.from({ length: 12 }, (_, index) => value.events(command(`cmd-${index}`, "fake-token-kQ9", "v"))).flat(),
    ];
    expect(roots.size).toBe(1);
    value.setValues([SECRET]);
    value.setValues([SECRET, SECRET]);
    emitted.push(...value.events(text("kQ9xZ2mB7vN4pL1sR8tW!", "t")));
    expect(roots.size).toBe(1);
    expect(streamed(emitted.filter(({ turnId }) => turnId === "t"))).toBe("a [redacted]!");
    value.setValues([SECRET, "second-secret-value-42"]);
    emitted.push(...value.events(text("kQ9xZ2mB7vN4pL1sR8tW second-secret-value-42.", "u")));
    expect(roots.size).toBe(2);
    expect(streamed(emitted.filter(({ turnId }) => turnId === "u"))).toBe("b [redacted] [redacted].");
  });

  it("keeps the same matcher when the active values arrive in another order", () => {
    const value = redactor([SECRET, "second-secret-value-42"]);
    const before = value.values();
    value.setValues(["second-secret-value-42", SECRET]);
    expect(value.values()).toBe(before);
  });

  it("re-evaluates a held split prefix against the new values when a value is removed or added mid-stream", () => {
    const value = redactor();
    expect(streamed(value.events(text("start fake-token-kQ9")))).toBe("start ");
    value.setValues([]);
    expect(streamed(value.events(text("xZ2 end")))).toBe("fake-token-kQ9xZ2 end");
    value.setValues([SECRET]);
    expect(streamed(value.events(text(` again ${SECRET.slice(0, 6)}`)))).toBe(" again ");
    expect(streamed(value.events(text(SECRET.slice(6))))).toBe("");
    expect(streamed(value.events({ ...BASE, type: "text-boundary" }))).toBe("[redacted]");
  });

  it("finishes and discards streams independently while they share a matcher", () => {
    const value = redactor();
    const first = value.events(command("a", "A fake-token-kQ9"));
    const second = value.events(command("b", "B fake-token-kQ9"));
    value.discard("t");
    const third = value.events(command("c", "C fake-token-kQ9xZ2mB7vN4pL1sR8tW"));
    const finished = value.result({ ...BASE, status: "completed", text: "" } as ProviderRunResult).events;
    const output = [...first, ...second, ...third, ...finished]
      .map((event) => (event.type === "activity" ? event.outputDelta ?? "" : "")).join("|");
    expect(output).toBe("A |B |C |[redacted]");
    expect(JSON.stringify(finished)).not.toContain("kQ9");
  });
});

describe("secret output redactor: identity fields", () => {
  it("leaves ids, types and kinds of events and results intact while hiding the value in their text", () => {
    const value = redactor(["turn-abc"]);
    const approval = {
      providerId: "codex", conversationId: "c", runId: "run-turn-abc", turnId: "turn-abc", type: "approval",
      request: { id: "approval-turn-abc", kind: "command", title: "Run turn-abc", command: "echo turn-abc" },
    } as unknown as ProviderEvent;
    const [out] = value.events(approval) as unknown as Array<{ turnId: string; runId: string; type: string; request: Record<string, string> }>;
    expect(out!.turnId).toBe("turn-abc");
    expect(out!.runId).toBe("run-turn-abc");
    expect(out!.request.id).toBe("approval-turn-abc");
    expect(out!.request.kind).toBe("command");
    expect(out!.request.title).toBe("Run [redacted]");
    expect(out!.request.command).toBe("echo [redacted]");

    const typed = redactor(["approval"]);
    const [kept] = typed.events({ ...approval, request: { id: "a1", kind: "approval", title: "Needs approval" } } as unknown as ProviderEvent) as unknown as Array<{ type: string; request: Record<string, string> }>;
    expect(kept!.type).toBe("approval");
    expect(kept!.request.kind).toBe("approval");
    expect(kept!.request.title).toBe("Needs [redacted]");

    const { result } = value.result({ ...BASE, turnId: "turn-abc", status: "completed", message: "done with turn-abc" } as unknown as ProviderRunResult);
    expect(result).toMatchObject({ turnId: "turn-abc", message: "done with [redacted]" });
  });

  it("still finds the value under an id-like key when checking what an agent wants to store", () => {
    const value = redactor(["turn-abc"]);
    const input = { fooId: "turn-abc" };
    expect(value.payload(input)).not.toBe(input);
    expect(value.payload(input, true)).toBe(input);
  });
});
