import { describe, expect, it, vi } from "vitest";

import { CodexHookStopTracker, codexHookStop, cutAtCodePointBoundary } from "../../src/server/codex/app-server-hook-stop";
import { sanitizeProviderUserText } from "../../src/server/provider/activity-detail";
import { MAX_PROVIDER_STOP_REASON_CHARS } from "../../src/shared/orchestration-v2";

const SECRET = "glpat-Q7xZ9mK2vR4tY8wP1nB6cD3fH5jL0sXa";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function reasonFor(run: Record<string, unknown>, environment: NodeJS.ProcessEnv = {}): string | undefined {
  const tracker = new CodexHookStopTracker({ environment, cwd: "/workspace/project" });
  tracker.observe({ threadId: "thread", turnId: "turn", run: { status: "stopped", ...run } }, "turn", "turn");
  return tracker.settle("turn", true);
}

function fragments(value: string, secret: string): string[] {
  return Array.from({ length: secret.length - 5 }, (unused, index) => secret.slice(index, index + 6))
    .filter((fragment) => value.includes(fragment));
}

describe("Codex hook stop text", () => {
  it("redacts a launch credential and its encodings wherever they cross a cut", () => {
    const environment = { GITLAB_TOKEN: SECRET };
    const encodings = [SECRET, Buffer.from(SECRET).toString("base64"), encodeURIComponent(SECRET)];
    // "Stop hook: " is 11 characters; the reason is cut at 2,000.
    for (const encoded of encodings) {
      for (let offset = 2_000 - encoded.length; offset <= 2_000; offset += 1) {
        const reason = reasonFor({ eventName: "Stop", entries: [{ kind: "stop", text: `${"S".repeat(offset - 11)}${encoded} end` }] },
          environment)!;
        expect(reason.length).toBeLessThanOrEqual(MAX_PROVIDER_STOP_REASON_CHARS);
        expect(fragments(reason, encoded.slice(6))).toEqual([]);
      }
    }
    // The event name is cut at 120 characters.
    for (let offset = 120 - SECRET.length; offset <= 120; offset += 1) {
      const reason = reasonFor({ eventName: `${"E".repeat(offset)}${SECRET}`, entries: [{ kind: "stop", text: "Stopped." }] },
        environment)!;
      expect(fragments(reason, SECRET.slice(6))).toEqual([]);
    }
  });

  it("keeps one long stop entry, redacting it whole before the cut", () => {
    const output = `Tests failed:\n${SECRET} ${"x".repeat(20 * 1024)}`;
    const reason = reasonFor({ eventName: "Stop", entries: [{ kind: "stop", text: output }] }, { GITLAB_TOKEN: SECRET })!;
    expect(reason.startsWith("Stop hook: Tests failed:\n[redacted] xxx")).toBe(true);
    expect(reason).toHaveLength(MAX_PROVIDER_STOP_REASON_CHARS);
  });

  it("stops joining at the first stop entry that would pass the bound, leaving no gap", () => {
    const first = "A".repeat(40 * 1024);
    const stop = codexHookStop({ run: { status: "stopped", eventName: "Stop", entries: [
      { kind: "stop", text: first },
      { kind: "stop", text: "B".repeat(30 * 1024) },
      { kind: "stop", text: "Short." },
    ] } });
    expect(stop?.text).toBe(first);
  });

  it("never leaves half of a surrogate pair at a cut", () => {
    // An emoji just before, across and just after the 120-character event name cut and the 2,000-character cut.
    for (const at of [118, 119, 120]) {
      const reason = reasonFor({ eventName: `${"E".repeat(at)}😀E`, entries: [{ kind: "stop", text: "Stopped." }] })!;
      expect(reason).not.toMatch(LONE_SURROGATE);
      expect(reason.startsWith(`${"E".repeat(at)}${at + 2 <= 120 ? "😀" : ""}`)).toBe(true);
    }
    for (const at of [1_998, 1_999, 2_000]) {
      // "Stop hook: " is 11 characters.
      const reason = reasonFor({ eventName: "Stop", entries: [{ kind: "stop", text: `${"S".repeat(at - 11)}😀 end` }] })!;
      expect(reason).not.toMatch(LONE_SURROGATE);
      expect(reason.length).toBe(at + 2 <= 2_000 ? 2_000 : at);
    }
    expect(cutAtCodePointBoundary("ab😀", 3)).toBe("ab");
    expect(cutAtCodePointBoundary("ab😀", 4)).toBe("ab😀");
  });

  it("keeps the user's text as written and removes only launch credentials, controls and local paths", () => {
    const clean = (value: string) => sanitizeProviderUserText(value, [SECRET], { workspaceRoot: "/workspace/project" });
    // T3 keeps the reason as written; Inertia removes only its own credentials (an AGENTS.md invariant).
    const prose = "Fix the token: handling; see prompt: README. password: is required. monkey=banana a-a-a=b";
    expect(clean(prose)).toBe(prose);
    expect(clean(`\u001b[31mKey ${SECRET} and ${Buffer.from(SECRET).toString("base64")} in /workspace/project/a.ts`))
      .toBe("Key [redacted] and [redacted] in <workspace>/a.ts");
    expect(reasonFor({ eventName: "Stop", entries: [{ kind: "stop", text: 'Codex said {"headers": {"x-token": "abc"}} here' }] }))
      .toBe('Stop hook: Codex said {"headers":"[redacted]"} here');
  });

  it("records no reason, and never throws into the protocol reader, when sanitising fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const environment = new Proxy({}, { ownKeys: () => { throw new RangeError("Invalid string length"); } });
    const tracker = new CodexHookStopTracker({ environment, cwd: "/workspace/project" });
    tracker.observe({ run: { status: "stopped", eventName: "Stop", entries: [{ kind: "stop", text: "Stopped." }] } },
      "turn", "turn");
    expect(() => tracker.settle("turn", true)).not.toThrow();
    expect(tracker.reason).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("A Codex hook stop reason could not be recorded.", "RangeError");
    warn.mockRestore();
  });

  it("ends the join at an oversized entry after kept text, so no gap is left", () => {
    expect(codexHookStop({ run: { status: "stopped", eventName: "Stop", entries: [
      { kind: "stop", text: "First." }, { kind: "stop", text: "x".repeat(256 * 1024 + 1) }, { kind: "stop", text: "Third." },
    ] } })?.text).toBe("First.");
  });

  it("redacts the common encodings of a launch credential, at every base64 alignment", () => {
    const secret = "pw/with space+plus";
    const bytes = Buffer.from(secret);
    const clean = (value: string) => sanitizeProviderUserText(value, [secret]);
    const encodings = [
      bytes.toString("hex"), bytes.toString("hex").toUpperCase(),
      encodeURIComponent(secret).replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
      encodeURIComponent(secret).replace(/%20/gu, "+"),
      JSON.stringify(secret).slice(1, -1).replaceAll("/", "\\/"),
    ];
    for (const encoded of encodings) expect(clean(`before ${encoded} after`)).toBe("before [redacted] after");
    for (const prefix of ["", "a", "ab"]) {
      for (const encoding of ["base64", "base64url"] as const) {
        const encoded = Buffer.concat([Buffer.from(prefix), bytes]).toString(encoding);
        const cleaned = clean(encoded);
        expect(cleaned).toContain("[redacted]");
        // At most the characters shared with the prefix or the padding remain on each side.
        expect(cleaned.replace("[redacted]", "").replace(/=+$/u, "").length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("merges overlapping credentials so no part of either is left", () => {
    expect(sanitizeProviderUserText("go AAAAAAAAxyz1BBBBBBBB now", ["AAAAAAAAxyz1", "xyz1BBBBBBBB"]))
      .toBe("go [redacted] now");
  });

  it("strips zero-width characters and escapes before matching credentials and header maps", () => {
    const split = `${SECRET.slice(0, 10)}\u200b${SECRET.slice(10)}`;
    expect(sanitizeProviderUserText(`key ${split}`, [SECRET])).toBe("key [redacted]");
    expect(reasonFor({ eventName: "Stop", entries: [{ kind: "stop", text: '{"head\u001b[0mers": {"x-token": "abc"}}' }] }))
      .toBe('Stop hook: {"headers":"[redacted]"}');
  });

  it("refuses a stop entry over the raw bound whole, before any sanitising", () => {
    const reason = reasonFor({ eventName: "Stop", entries: [
      { kind: "stop", text: `${"T".repeat(256 * 1024 - SECRET.length + 1)}${SECRET}` },
      { kind: "stop", text: "Kept." },
    ] }, { GITLAB_TOKEN: SECRET });
    expect(reason).toBe("Stop hook: Kept.");
  });

  // Performance guard, following session-unavailable-classification.test.ts: every step is a literal match or a
  // single forward scan, so 256 KiB of adversarial text finishes in milliseconds. The bound is generous on purpose;
  // the quadratic pattern this replaced took 38 s on 256 KiB of "a-".
  const ADVERSARIAL: Array<[string, string]> = [
    ["a-a-", "a-".repeat(128 * 1024)],
    ["a_a_", "a_".repeat(128 * 1024)],
    ["one unbroken word", "a".repeat(256 * 1024)],
    ["many equals signs", "=".repeat(256 * 1024)],
    ["key=value runs", "KEY=".repeat(64 * 1024)],
    ["unterminated escapes", "\u001b]\u001b[0".repeat(256 * 1024 / 5)],
    ["unclosed header maps", "headers: {".repeat(256 * 1024 / 10)],
  ];
  it.each(ADVERSARIAL)("sanitises 256 KiB of %s in linear time", (_label, text) => {
    const started = performance.now();
    const reason = reasonFor({ eventName: "Stop", entries: [{ kind: "stop", text: text.slice(0, 256 * 1024) }] },
      { GITLAB_TOKEN: SECRET, OTHER_API_KEY: "another-credential-value" });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(reason === undefined || reason.length <= MAX_PROVIDER_STOP_REASON_CHARS).toBe(true);
  });
});
