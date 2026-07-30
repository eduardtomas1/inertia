import { describe, expect, it } from "vitest";

import {
  sanitizeRemoteContent,
  sanitizeRemoteLabel,
} from "../src/shared/remote-sanitizer";

describe("Remote Companion safe text projection", () => {
  it("removes local paths, credential material, code, and HTML blocks", () => {
    const projected = sanitizeRemoteContent([
      "Read /Users/alice/private/secret.ts",
      "Build /workspace/acme/.env, deploy /srv/project/file.ts;",
      "Inspect /usr/local/config:12 and file:///workspace/private.txt.",
      "Then C:\\Users\\alice\\private\\secret.ts",
      "Bearer highly-sensitive-token-value",
      "```ts\nconst token = 'sk-secretvalue123456';\n```",
      "<script>alert('provider output')</script>",
      "https://user:password@example.invalid/path",
    ].join("\n"));

    expect(projected).not.toContain("/Users/alice");
    expect(projected).not.toContain("/workspace");
    expect(projected).not.toContain("/srv/project");
    expect(projected).not.toContain("/usr/local");
    expect(projected).not.toContain("C:\\Users");
    expect(projected).not.toContain("highly-sensitive");
    expect(projected).not.toContain("sk-secret");
    expect(projected).not.toContain("<script>");
    expect(projected).not.toContain("user:password");
    expect(projected).toContain("<local-path>");
    expect(projected).toContain("<local-path>, deploy <local-path>;");
    expect(projected).toContain("<local-path>:12");
    expect(projected).toContain("file://<local-path>.");
    expect(projected).toContain("[Code omitted on Remote Companion]");
  });

  it("preserves web URLs and punctuation around redacted POSIX paths", () => {
    const projected = sanitizeRemoteContent(
      [
        "See https://example.invalid/a/b?x=1",
        "and wss://[::1]/remote, then (/workspace/app/file.ts).",
        "Also redact label:/srv/app and comma,/usr/local/bin.",
      ].join(" "),
    );

    expect(projected).toContain("https://example.invalid/a/b?x=1");
    expect(projected).toContain("wss://[::1]/remote");
    expect(projected).toContain("(<local-path>).");
    expect(projected).toContain("label:<local-path>");
    expect(projected).toContain("comma,<local-path>");
  });

  it("bounds and normalizes labels", () => {
    expect(sanitizeRemoteLabel("  hello\u0000\n world ", 20)).toBe(
      "hello world",
    );
    expect(sanitizeRemoteLabel("x".repeat(100), 20)).toHaveLength(20);
    expect(sanitizeRemoteLabel(
      "\u202eTrusted\u202c\u0000 Browser\u2066",
      80,
    )).toBe("Trusted Browser");
  });
});
