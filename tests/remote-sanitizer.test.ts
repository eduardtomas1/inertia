import { win32 } from "node:path";

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
      "Copy \\\\server\\share\\project\\.env, then \\\\host\\private\\file.txt.",
      "Mixed \\\\server/share\\project/.env and \\\\host/private\\file.txt.",
      "Extended \\\\?\\C:\\project\\.env and \\\\?\\UNC\\server\\share\\secret.txt.",
      "Extended mixed \\\\?\\UNC\\server/share\\secret.txt.",
      "Device \\\\.\\PhysicalDrive0.",
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
    expect(projected).not.toContain("\\\\server\\share");
    expect(projected).not.toContain("\\\\host\\private");
    expect(projected).not.toContain("\\\\server/share");
    expect(projected).not.toContain("\\\\host/private");
    expect(projected).not.toContain("\\\\?\\");
    expect(projected).not.toContain("\\\\.\\");
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

  it("preserves web URLs and punctuation around redacted local paths", () => {
    const projected = sanitizeRemoteContent(
      [
        "See https://example.invalid/a/b?x=1",
        "and wss://[::1]/remote, then (/workspace/app/file.ts).",
        "Also redact label:/srv/app and comma,/usr/local/bin.",
        "UNC (\\\\server\\share\\app\\.env).",
        "UNC label:\\\\host\\private\\file.txt, then done.",
        "Mixed UNC (\\\\server/share\\app/.env).",
        "Mixed UNC label:\\\\host/private\\file.txt, then done.",
        "Extended (\\\\?\\C:\\project\\file.txt).",
        "Extended UNC \\\\?\\UNC\\server\\share\\file.txt, then done.",
        "Extended mixed UNC \\\\?\\UNC\\server/share\\file.txt, then done.",
        "Device \\\\.\\pipe\\inertia-test; done.",
        "Keep escaped prose \\\\ and regex \\\\d+ intact.",
      ].join(" "),
    );

    expect(projected).toContain("https://example.invalid/a/b?x=1");
    expect(projected).toContain("wss://[::1]/remote");
    expect(projected).toContain("(<local-path>).");
    expect(projected).toContain("label:<local-path>");
    expect(projected).toContain("comma,<local-path>");
    expect(projected).toContain("UNC (<local-path>).");
    expect(projected).toContain("UNC label:<local-path>, then done.");
    expect(projected).toContain("Mixed UNC (<local-path>).");
    expect(projected).toContain("Mixed UNC label:<local-path>, then done.");
    expect(projected).toContain("Extended (<local-path>).");
    expect(projected).toContain("Extended UNC <local-path>, then done.");
    expect(projected).toContain(
      "Extended mixed UNC <local-path>, then done.",
    );
    expect(projected).toContain("Device <local-path>; done.");
    expect(projected).toContain(
      "Keep escaped prose \\\\ and regex \\\\d+ intact.",
    );
  });

  it("redacts Windows UNC separator variants recognized by path normalization", () => {
    const normalizedUnc = String.raw`\\server\share\project\.env`;
    const uncPaths = [
      normalizedUnc,
      String.raw`\\server/share/project/.env`,
      String.raw`\\server/share\project/.env`,
    ];
    for (const path of uncPaths) {
      expect(win32.isAbsolute(path)).toBe(true);
      expect(win32.normalize(path)).toBe(normalizedUnc);
      expect(sanitizeRemoteContent(`Path (${path}).`)).toBe(
        "Path (<local-path>).",
      );
    }

    const devicePaths = [
      String.raw`\\?\C:\project/.env`,
      String.raw`\\?\UNC\server/share\secret.txt`,
      String.raw`\\.\pipe/inertia-test`,
    ];
    for (const path of devicePaths) {
      expect(win32.isAbsolute(path)).toBe(true);
      expect(sanitizeRemoteContent(`Path label:${path}, then done.`)).toBe(
        "Path label:<local-path>, then done.",
      );
    }

    const ordinaryText = [
      "https://example.invalid/server/share/project/.env",
      "wss://[::1]/remote",
      String.raw`Keep escaped prose \\ and regex \\d+ intact.`,
    ].join(" ");
    expect(sanitizeRemoteContent(ordinaryText)).toBe(ordinaryText);
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
