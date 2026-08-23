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
      "https://prefix_sk-abcdefgh12345678.example.com/private",
    )).toBeNull();
    expect(browserEvidenceOrigin(
      "https://prefix_ghp_abcdefgh12345678.example.com/private",
    )).toBeNull();
    expect(browserEvidenceOrigin(
      "https://AKIA1234567890ABCDEF.example.com/private",
    )).toBeNull();
    expect(browserEvidenceOrigin("https://prefix-sketchbook.example.com/private"))
      .toBe("https://prefix-sketchbook.example.com");
  });

  it.each([
    "Authorization: Bearer private-value",
    "oauth_access_token=private-value",
    "prefix_auth_token: private-value",
    "oauthAccessToken=private-value",
    "githubToken: private-value",
    "clientSecret = private-value",
    "awsSecretAccessKey=private-value",
    "githubPAT=private-value",
    "clientPassphrase=private-value",
    "browserSessionId=private-value",
    "sessionId=private-value",
    "secretKey: private-value",
    "ClientSecret=private-value",
    "authTokenValue=x",
    "apiKeyValue=y",
    "clientSecretValue=z",
    "SessionIdValues=q",
    "CLIENT_SECRET_KEY=private-value",
    "\"oauthAccessToken\":\"private-value\"",
    "\"SessionId\":\"private-value\"",
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

  it.each([
    "prefix_Bearer private-value",
    "prefix_sk-abcdefgh12345678",
    "prefix_eyJabcdefgh.ijklmnop.qrstuvwx",
    "prefix_abcdefghijklmno1234567890qrstuv",
  ])("redacts secret values attached to identifier separators: %s", (value) => {
    const result = sanitizeBrowserEvidenceText(value, "hidden");
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(value.slice("prefix_".length));
  });

  it("does not treat a sensitive-field substring in normal prose as a field", () => {
    expect(sanitizeBrowserEvidenceText("The obsession ended normally.", "hidden"))
      .toEqual({ text: "The obsession ended normally.", redacted: false });
  });

  it.each([
    "tokenize=public-value",
    "cancellationTokenCount=4",
    "clientSecretariat=public-value",
    "SessionIdentity=public-value",
    "ApiKeynote=public-value",
    "ClientSecretariat=public-value",
    "authTokenValueCount=4",
    "ApiKeyValueFactory=public-value",
    "ClientSecretValueObject=public-value",
  ])("does not treat a camel-case suffix substring as a credential field: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: value, redacted: false });
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
    "Failure in ~/private/main.ts",
    "Failure in /Users/Jane Doe/private project/src/main.ts",
    "Failure in packages/browser/private project/src/main.ts",
    "Failure in ~/Jane Doe/private project/src/main.ts",
    "Failure in file:///Users/Jane%20Doe/private%20project/src/main.ts",
    "prefix_/Users/Jane Doe/private project",
    "prefix_file:///Users/Jane Doe/private project",
  ])("fails closed for POSIX, file, home, and relative filesystem paths: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: "hidden", redacted: true });
  });

  it.each([
    String.raw`Failure in C:\Users\Jane\private\main.ts`,
    String.raw`Failure in C:\Users\Jane Doe\private project\src\main.ts`,
    "Failure in C:/Users/Jane Doe/private project/src/main.ts",
    String.raw`Failure in \\server\private\main.ts`,
    String.raw`Failure in \\server\private share\src\main.ts`,
    "Failure in //server/private share/src/main.ts",
  ])("fails closed for complete Windows filesystem paths: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: "hidden", redacted: true });
  });

  it("strips URL routes, filesystem paths, tokens, controls, and bidi text", () => {
    const result = sanitizeBrowserEvidenceText(
      "Failed http://localhost:3000/private?draft=value#section "
      + "with ghp_abcdefgh12345678\u0000\u202ereordered",
      "hidden",
    );
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("http://localhost:3000");
    expect(result.text).toContain("<redacted>");
    expect(result.text).not.toContain("private?draft");
    expect(result.text).not.toContain("ghp_abcdefgh");
    expect(result.text).not.toMatch(/[\u0000\u202e]/u);
  });

  it.each([
    "Render used 1/2 of the frame budget.",
    "Choose yes/no when prompted.",
    "Opened profile://example during setup.",
    "Failed https://example.com/private?next=/docs#section during render.",
  ])("does not mistake normal prose or HTTP URLs for filesystem paths: %s", (value) => {
    const result = sanitizeBrowserEvidenceText(value, "hidden");
    expect(result.text).not.toBe("hidden");
  });

  it.each([
    "prefix_https://localhost/private?draft=private-value",
    "prefix_https://localhost/private%20project?draft=private-value",
  ])("redacts HTTP URLs attached to identifier characters: %s", (value) => {
    const result = sanitizeBrowserEvidenceText(value, "hidden");
    expect(result.text).toContain("https://localhost");
    expect(result.text).not.toContain("private");
    expect(result.redacted).toBe(true);
  });

  it.each([
    "prefix_https://localhost/private?access_token=private-value",
    "prefix_h%74tps://localhost/private?access_token=private-value",
    "prefix_http%3A%2F%2Flocalhost/private?access_token=private-value",
    "prefix_h\u0000ttps://localhost/private?draft=private-value",
  ])("fails closed for credential-bearing or encoded HTTP schemes: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: "hidden", redacted: true });
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
