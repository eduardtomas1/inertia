import { describe, expect, it } from "vitest";

import { BrowserEvidenceLedger } from "../../src/main/browser-evidence-ledger";
import { MAX_BROWSER_EVIDENCE_ENTRIES } from "../../src/shared/browser-evidence";

const tabId = "11111111-1111-4111-8111-111111111111";
const authority = {
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
};
const location = {
  tabId,
  pageNumber: 1,
  documentSequence: 2,
  authority,
};

describe("Browser evidence ledger", () => {
  it("keeps a closed, sanitized projection of console and network failures", () => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({
      ...location,
      message: "Failed at /Users/alice/private.ts using http://localhost:3000/private?draft=value",
    });
    ledger.recordNetworkFailure({
      ...location,
      url: "http://localhost:3000/api/private?authorization=secret#hash",
      method: "POST",
      resourceType: "xhr",
      outcome: 503,
    });

    const serialized = JSON.stringify(ledger.snapshot());
    expect(serialized).toContain("Sensitive console detail hidden");
    expect(serialized).toContain("http://localhost:3000");
    expect(serialized).toContain("HTTP 503");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("private.ts");
    expect(serialized).not.toContain("authorization=secret");
    expect(serialized).not.toContain("#hash");
    expect(ledger.snapshot().entries.every((entry) =>
      entry.runId === authority.runId && entry.turnId === authority.turnId
    )).toBe(true);
  });

  it("coalesces repeats and bounds metadata without losing monotonic sequence", () => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({ ...location, message: "render failed" });
    ledger.recordConsoleError({ ...location, message: "render failed" });
    expect(ledger.snapshot().entries).toMatchObject([{
      sequence: 1,
      occurrences: 2,
    }]);

    for (let index = 0; index < MAX_BROWSER_EVIDENCE_ENTRIES + 8; index += 1) {
      ledger.recordNavigation({
        ...location,
        documentSequence: index + 3,
        url: `http://localhost:3000/page-${index}?token=hidden`,
        sameDocument: false,
      });
    }
    const snapshot = ledger.snapshot();
    expect(snapshot.entries).toHaveLength(MAX_BROWSER_EVIDENCE_ENTRIES);
    expect(snapshot.omitted).toBe(true);
    expect(snapshot.entries[0]!.sequence).toBeGreaterThan(1);
    expect(snapshot.entries.at(-1)!.sequence).toBeGreaterThan(
      snapshot.entries[0]!.sequence,
    );
  });

  it("keeps at most eight bounded screenshot handles and drops all bytes on clear", () => {
    const ledger = new BrowserEvidenceLedger();
    const ids: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      ids.push(ledger.recordScreenshot({
        ...location,
        documentSequence: index,
        url: "http://localhost:3000/private?token=hidden",
        data: Buffer.from(`png-${index}`).toString("base64"),
        width: 512,
        height: 320,
      }).id);
    }
    expect(ledger.image(ids[0]!)).toBeNull();
    expect(ledger.image(ids.at(-1)!)).toMatchObject({ mimeType: "image/png" });
    expect(ledger.snapshot().entries[0]!.screenshot?.available).toBe(false);
    ledger.clear();
    expect(ledger.image(ids.at(-1)!)).toBeNull();
    expect(ledger.snapshot().entries).toEqual([]);
  });
});
