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

  it.each([
    "sessionId=x",
    "secretKey: y",
    "ClientSecret=z",
    "authTokenValue=x",
    "apiKeyValue=y",
    "clientSecretValue=z",
    "\"SessionId\":\"q\"",
    "pass=hunter2",
    "PASS : hunter2",
    "\"pass\":\"hunter2\"",
    "db_pass=hunter2",
    "databasePass=hunter2",
    "passValue=hunter2",
    "passValues=hunter2",
    "pass_value=hunter2",
    "pwd=hunter2",
    "PWD : hunter2",
    "\"pwd\":\"hunter2\"",
    "databasePwd=hunter2",
    "passphrase=hunter2",
    "passcode=hunter2",
    "PGPASSWORD=hunter2",
    "postgres://alice:hunter2@localhost/private",
    "MONGODB_URI=mongodb://alice:hunter2@localhost/private",
    "tok\u0000en=hunter2",
    "pass\u202dword=hunter2",
    "tok\u200ben=hunter2",
    "tok％65n=hunter2",
    "sk%00-abcdefgh12345678",
    "sk\u0000-abcdefgh12345678",
    "dbpass=hunter2",
    "mypassValue=hunter2",
    "prodpass=hunter2",
    "tenantpass=hunter2",
    "clientpassvalues=hunter2",
    "dbp%61ss=hunter2",
    "dbp\u200bass=hunter2",
    "\"CLIENTPASSVALUES\" : \"hunter2\"",
  ])("fails closed before storing a page-authored credential shape: %s", (message) => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({ ...location, message });

    const serialized = JSON.stringify(ledger.snapshot());
    expect(serialized).toContain("Sensitive console detail hidden");
    expect(serialized).not.toContain(message);
  });

  it.each([
    "gho_abcdefghijklmnop",
    "ghu_abcdefghijklmnop",
    "ghs_abcdefghijklmnop",
    "ghr_abcdefghijklmnop",
  ])("projects a recognizable GitHub token before ledger storage: %s", (message) => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({ ...location, message });

    expect(ledger.snapshot().entries).toMatchObject([{
      detail: "<redacted>",
      redacted: true,
    }]);
    expect(JSON.stringify(ledger.snapshot())).not.toContain(message);
  });

  it.each([
    "tokenize=ok",
    "SessionIdentity=ok",
    "ClientSecretariat=ok",
    "authTokenValueCount=4",
    "ClientSecretValueObject=ok",
    "The pwd field is empty",
    "The pass completed normally",
    "The passcode prompt is visible",
    "compass=public",
    "bypass=public",
    "passCount=4",
    "compassValue=public",
    "bypassValues=public",
    "pass_value_count=4",
    "db_pass is unset",
    "PGPASSWORD is unset",
    "underpass=public",
    "overpassValues=public",
    "mypassCount=4",
    "Ratios x/y and a/b are invalid",
    "Progress 1/2 complete 3/4",
  ])("keeps a non-credential page-authored identifier: %s", (message) => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({ ...location, message });

    expect(ledger.snapshot().entries).toMatchObject([{
      detail: message,
      redacted: false,
    }]);
  });

  it("keeps only the authority of a credential-free non-HTTP URI", () => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({
      ...location,
      message: "postgres://localhost/private?mode=public#setup",
    });

    expect(ledger.snapshot().entries).toMatchObject([{
      detail: "postgres://localhost",
      redacted: true,
    }]);
  });

  it.each([
    "Failure opening /root-ledger-secret",
    "Failure at C://Users/Jane Doe/private/file.txt",
    String.raw`Failure in C:Users\Jane Doe\private\config`,
    "Failure at //private-server/secret share/file.txt",
  ])("fails closed before storing a URI-shaped filesystem path: %s", (message) => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({ ...location, message });

    const serialized = JSON.stringify(ledger.snapshot());
    expect(serialized).toContain("Sensitive console detail hidden");
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("root-ledger-secret");
    expect(serialized).not.toContain("C:Users");
    expect(serialized).not.toContain("private-server");
  });

  it.each([
    "Failed in src/private/config",
    "Failed in src/config",
    "Failed in src/.env",
    "Failed in ./Dockerfile",
    String.raw`Failed in src\private\config`,
    String.raw`Failed in src\config`,
    "Failure in projects/Jane Doe/config",
    String.raw`Failure in workspace\Jane Doe\config`,
    "Failure in users/Jane Doe/config",
    String.raw`Failure in users\Jane Doe\config`,
  ])("fails closed before storing an extensionless relative path: %s", (message) => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordConsoleError({ ...location, message });

    const serialized = JSON.stringify(ledger.snapshot());
    expect(serialized).toContain("Sensitive console detail hidden");
    expect(serialized).not.toContain(message);
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

  it("does not coalesce repeats across a chronologically adjacent navigation", () => {
    const ledger = new BrowserEvidenceLedger();
    ledger.recordNavigation({
      ...location,
      occurredAt: "2026-08-23T11:00:01.000Z",
      occurrenceSequence: 2,
      url: "https://example.com/history",
      sameDocument: true,
    });
    ledger.recordConsoleError({
      ...location,
      occurredAt: "2026-08-23T11:00:00.000Z",
      occurrenceSequence: 1,
      message: "identical delayed error",
    });
    ledger.recordConsoleError({
      ...location,
      occurredAt: "2026-08-23T11:00:02.000Z",
      occurrenceSequence: 3,
      message: "identical delayed error",
    });

    expect(ledger.snapshot().entries).toMatchObject([
      { kind: "console-error", occurrences: 1, sequence: 1 },
      { kind: "navigation", occurrences: 1, sequence: 2 },
      { kind: "console-error", occurrences: 1, sequence: 3 },
    ]);
  });

  it("evicts a delayed older entry before later navigation occurrences", () => {
    const ledger = new BrowserEvidenceLedger();
    for (let index = 0; index < MAX_BROWSER_EVIDENCE_ENTRIES; index += 1) {
      ledger.recordNavigation({
        ...location,
        documentSequence: index + 3,
        occurredAt: new Date(1_000 + index).toISOString(),
        url: `http://localhost:3000/page-${index}`,
        sameDocument: false,
      });
    }
    ledger.recordConsoleError({
      ...location,
      occurredAt: new Date(0).toISOString(),
      message: "delayed older failure",
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.entries).toHaveLength(MAX_BROWSER_EVIDENCE_ENTRIES);
    expect(snapshot.omitted).toBe(true);
    expect(snapshot.entries).not.toContainEqual(expect.objectContaining({
      detail: "delayed older failure",
    }));
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentSequence: 3 }),
      expect.objectContaining({
        documentSequence: MAX_BROWSER_EVIDENCE_ENTRIES + 2,
      }),
    ]));
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
