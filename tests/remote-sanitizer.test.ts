import { describe, expect, it } from "vitest";

import {
  sanitizeRemoteContent,
  sanitizeRemoteLabel,
} from "../src/shared/remote-sanitizer";

describe("Remote Companion safe text projection", () => {
  it("removes local paths, credential material, code, and HTML blocks", () => {
    const projected = sanitizeRemoteContent([
      "Read /Users/alice/private/secret.ts",
      "Then C:\\Users\\alice\\private\\secret.ts",
      "Bearer highly-sensitive-token-value",
      "```ts\nconst token = 'sk-secretvalue123456';\n```",
      "<script>alert('provider output')</script>",
      "https://user:password@example.invalid/path",
    ].join("\n"));

    expect(projected).not.toContain("/Users/alice");
    expect(projected).not.toContain("C:\\Users");
    expect(projected).not.toContain("highly-sensitive");
    expect(projected).not.toContain("sk-secret");
    expect(projected).not.toContain("<script>");
    expect(projected).not.toContain("user:password");
    expect(projected).toContain("<local-path>");
    expect(projected).toContain("[Code omitted on Remote Companion]");
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
