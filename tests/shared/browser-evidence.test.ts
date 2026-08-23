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
    "pwd=hunter2",
    "pwd: hunter2",
    "PWD = hunter2",
    "\"pwd\" : \"hunter2\"",
    "'Pwd' : 'hunter2'",
    "databasePwd=hunter2",
    "passphrase=hunter2",
    "passcode: hunter2",
    "clientPasscode=hunter2",
    "PGPASSWORD=hunter2",
    "\"PGPASSWORD\": \"hunter2\"",
    "MYSQL_PWD=hunter2",
    "REDIS_PASSWORD=hunter2",
    "pwd%3Dhunter2",
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
    "The pwd field is empty after setup.",
    "The pass completed normally.",
    "The passcode prompt is visible.",
    "The passphrase prompt is visible.",
  ])("does not treat a password alias in ordinary prose as an assignment: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: value, redacted: false });
  });

  it.each([
    "PGPASSWORD is unset after setup.",
    "MYSQL_PWD is documented by the adapter.",
    "MONGODB_URI is configured separately.",
  ])("does not treat an environment key in ordinary prose as an assignment: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: value, redacted: false });
  });

  it.each([
    "postgres://alice:hunter2@localhost/private",
    "PoStGrEs://alice:hunter2@localhost/private",
    "postgresql://alice:hunter2@localhost/private",
    "mysql://alice:hunter2@localhost/private",
    "mongodb://alice:hunter2@localhost/private",
    "redis://alice:hunter2@localhost/private",
    "amqp://alice:hunter2@localhost/private",
    "ssh://alice:hunter2@localhost/private",
    "//alice:hunter2@localhost/private",
    "postgres%3A%2F%2Falice%3Ahunter2%40localhost%2Fprivate",
    "postgres://alice%3Ahunter2%40localhost/private",
    "MONGODB_URI=MoNgOdB://alice:hunter2@localhost/private",
    "\"MONGODB_URI\":\"mongodb://alice:hunter2@localhost/private\"",
  ])("fails closed for credential-bearing hierarchical URI: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: "hidden", redacted: true });
  });

  it.each([
    ["postgres://localhost/private", "postgres://localhost"],
    ["postgresql://localhost:5432/private", "postgresql://localhost:5432"],
    ["ssh://git@github.com/project/repository", "ssh://github.com"],
    ["MONGODB_URI=mongodb://localhost/private", "MONGODB_URI=mongodb://localhost"],
  ])("projects a credential-free hierarchical URI without failing closed: %s", (value, projected) => {
    const result = sanitizeBrowserEvidenceText(value, "hidden");
    expect(result).toEqual({ text: projected, redacted: true });
  });

  it.each([
    "The worker reported ratio: 2@home.",
    "Contact alice@example.com after the pass.",
    "Namespace::member rendered normally.",
  ])("keeps ordinary colon and at-sign prose: %s", (value) => {
    expect(sanitizeBrowserEvidenceText(value, "hidden"))
      .toEqual({ text: value, redacted: false });
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
    "Failed in src/private/config",
    "Failed in src/config",
    "Failed in src/.env",
    "Failed in ./Dockerfile",
    "Failed in ../Makefile",
    String.raw`Failed in src\private\config`,
    String.raw`Failed in src\config`,
    String.raw`Failed in .\Dockerfile`,
    String.raw`Failed in package\private\config`,
    String.raw`Failed in package\private.txt`,
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
    "Failure at C://Users/Jane Doe/private/file.txt",
    String.raw`Failure in \\server\private\main.ts`,
    String.raw`Failure in \\server\private share\src\main.ts`,
    "Failure in //server/private share/src/main.ts",
    "Failure at //private-server/secret share/file.txt",
    "//localhost/private",
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
    String.raw`Choose yes\no when prompted.`,
    "Dockerfile checks completed normally.",
    ".env variables are documented separately.",
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
