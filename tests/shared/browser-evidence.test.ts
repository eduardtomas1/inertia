import { describe, expect, it } from "vitest";

import {
  browserEvidenceOrigin,
  sanitizeBrowserEvidenceText,
} from "../../src/shared/browser-evidence";

describe("Browser evidence sanitization", () => {
  it("projects navigation and request URLs to an origin only", () => {
    expect(browserEvidenceOrigin(
      "http://127.0.0.1:4173/reset/private-token?access_token=secret#draft-secret",
    )).toBe("http://127.0.0.1:4173");
    expect(browserEvidenceOrigin("https://user:secret@example.com/private"))
      .toBeNull();
    expect(browserEvidenceOrigin("file:///Users/private/project/index.html"))
      .toBeNull();
    expect(browserEvidenceOrigin(
      "https://a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.example.com/",
    )).toBeNull();
    expect(browserEvidenceOrigin(
      "https://sk-abcdefgh12345678.example.com/private",
    )).toBeNull();
    expect(browserEvidenceOrigin(
      "https://AKIA1234567890ABCDEF.example.com/private",
    )).toBeNull();
  });

  it.each([
    "Authorization: Bearer private-value",
    "Cookie=session=private-value",
    "Set-Cookie: session=private-value",
    "password=private-value",
    "request_body: private-value",
    "token%3Dprivate-value",
    "sk%252Dabcdefgh12345678",
    "render failed 100% sk%2Dabcdefgh12345678",
    "sk%252525252Dabcdefgh12345678",
    "-----BEGIN PRIVATE KEY-----",
  ])("fails closed for credential-bearing console detail: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "Sensitive console detail hidden"))
      .toEqual({ text: "Sensitive console detail hidden", redacted: true });
  });

  it("fails closed for malformed page-authored percent encoding", () => {
    expect(sanitizeBrowserEvidenceText("render reached 100%", "hidden"))
      .toEqual({ text: "hidden", redacted: true });
  });

  it.each([
    "Cloud value AKIA1234567890ABCDEF",
    "Cloud value AIza1234567890abcdefghijklmno",
  ])("redacts recognizable credential prefixes: %s", (value) => {
    const result = sanitizeBrowserEvidenceText(value, "hidden");
    expect(result).toMatchObject({ redacted: true });
    expect(result.text).not.toContain(value.split(" ").at(-1));
  });

  it.each([
    "Failure in /workspace/inertia/src/main.ts",
    "Failure in /uncommon-root/private/output.ts",
    "Failure in packages/browser/private/output.ts",
    "Failure in \\\\server\\private\\main.ts",
    "Failure in ~/private/main.ts",
  ])("removes platform filesystem paths: %s", (value) => {
    const result = sanitizeBrowserEvidenceText(value, "hidden");
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("<path>");
    expect(result.text).not.toContain("main.ts");
  });

  it("strips URL routes, filesystem paths, tokens, controls, and bidi text", () => {
    const result = sanitizeBrowserEvidenceText(
      "Failed http://localhost:3000/private?draft=value#section at /Users/alice/project/app.ts "
      + "with ghp_abcdefgh12345678\u0000\u202ereordered",
      "hidden",
    );
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("http://localhost:3000");
    expect(result.text).toContain("<path>");
    expect(result.text).toContain("<redacted>");
    expect(result.text).not.toContain("private?draft");
    expect(result.text).not.toContain("alice");
    expect(result.text).not.toContain("ghp_abcdefgh");
    expect(result.text).not.toMatch(/[\u0000\u202e]/u);
  });

  it("bounds oversized multibyte page text without retaining a secret fragment", () => {
    const result = sanitizeBrowserEvidenceText(
      `${"é".repeat(900)} Bearer partial-secret`,
      "hidden",
      120,
    );
    expect(result).toEqual({ text: "hidden", redacted: true });
  });
});
