import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";

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

  it("redacts url user-info through the authority's final at-sign", () => {
    expect(sanitizeRemoteContent("https://alice:pa@ss@example.com/private"))
      .toBe("https://<redacted>@example.com/private");
    expect(sanitizeRemoteContent("https://a:b@c@d@example.com/x"))
      .toBe("https://<redacted>@example.com/x");
    expect(sanitizeRemoteContent("see https://example.com/a@b for details"))
      .toBe("see https://example.com/a@b for details");
    expect(sanitizeRemoteContent("https://example.com/?q=a@b"))
      .toBe("https://example.com/?q=a@b");
    expect(sanitizeRemoteContent("mail bob@example.com now"))
      .toBe("mail bob@example.com now");
  });

  it("redacts alternate, interrupted, and indented code blocks", () => {
    const cases = [
      [
        "Before\n~~~ts\nconst tildeSecret = true;\n~~~\nAfter",
        "Before\n[Code omitted on Remote Companion]\nAfter",
      ],
      [
        "Before\n~~~ts ~~~\nconst tildeInfoSecret = true;\n~~~\nAfter",
        "Before\n[Code omitted on Remote Companion]\nAfter",
      ],
      [
        "Before\n```ts\nconst interruptedSecret = true;",
        "Before\n[Code omitted on Remote Companion]",
      ],
      [
        "Before\n   ````ts\nconst longFenceSecret = true;\n   ````\nAfter",
        "Before\n[Code omitted on Remote Companion]\nAfter",
      ],
      [
        "Before\n    const indentedSecret = true;\n    return indentedSecret;\nAfter",
        "Before\n[Code omitted on Remote Companion]\nAfter",
      ],
      [
        "Before\n\tconst tabSecret = true;\n\n\treturn tabSecret;\nAfter",
        "Before\n[Code omitted on Remote Companion]\nAfter",
      ],
      [
        "```ts const oneLineSecret = true; ```\nAfter",
        "[Code omitted on Remote Companion]",
      ],
    ] as const;
    for (const [input, expected] of cases) {
      expect(sanitizeRemoteContent(input)).toBe(expected);
      expect(sanitizeRemoteContent(input)).not.toContain("Secret");
    }
    expect(sanitizeRemoteContent(
      "Use `inline code` and ~~ordinary emphasis~~ in prose.",
    )).toBe("Use `inline code` and ~~ordinary emphasis~~ in prose.");
  });

  it("redacts interrupted, self-closing, and nested HTML linearly", () => {
    const cases = [
      [
        "Before <img src=\"private.png\" /> after",
        "Before [HTML omitted on Remote Companion] after",
      ],
      [
        "Before <div><span>nested secret</span><div>inner</div></div> after",
        "Before [HTML omitted on Remote Companion] after",
      ],
      [
        "Before <x-private>custom secret</x-private> after",
        "Before [HTML omitted on Remote Companion] after",
      ],
      [
        "Before <x-private data-kind=\"secret\" /> after",
        "Before [HTML omitted on Remote Companion] after",
      ],
      [
        "Before </script> unmatched prose after",
        "Before [HTML omitted on Remote Companion] unmatched prose after",
      ],
      [
        "Before <div><span>mismatched secret</div> after",
        "Before [HTML omitted on Remote Companion]",
      ],
      [
        "Before <script>interrupted secret",
        "Before [HTML omitted on Remote Companion]",
      ],
      [
        "Before <script src=\"interrupted.js\"",
        "Before [HTML omitted on Remote Companion]",
      ],
      [
        "Before <!-- interrupted secret",
        "Before [HTML omitted on Remote Companion]",
      ],
      [
        "Before <br> after",
        "Before [HTML omitted on Remote Companion] after",
      ],
    ] as const;
    for (const [input, expected] of cases) {
      expect(sanitizeRemoteContent(input)).toBe(expected);
      expect(sanitizeRemoteContent(input)).not.toContain("secret");
    }
    expect(sanitizeRemoteContent(
      "Compare <value> and 2 < 3; keep <https://example.invalid/a>, "
        + "but redact </home/alice/.env>.",
    )).toBe(
      "Compare <value> and 2 < 3; keep <https://example.invalid/a>, "
        + "but redact <<local-path>>.",
    );
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

  it("redacts POSIX absolute tokens with legal punctuation and separator runs", () => {
    const paths = [
      "/",
      "/.",
      "/..",
      "/!",
      "/!private/.env",
      "/:secret/file",
      "/[tenant]/key",
      "/name[1]/semi;colon/file#1",
      "/name[1]/file!",
      "//srv///project//file",
    ];
    for (const path of paths) {
      expect(posix.isAbsolute(path)).toBe(true);
      expect(sanitizeRemoteContent(`Path (${path}).`)).toBe(
        "Path (<local-path>).",
      );
      expect(sanitizeRemoteContent(`Path label:${path}, then done.`)).toBe(
        "Path label:<local-path>, then done.",
      );
      expect(sanitizeRemoteContent(`Path ${path}`)).not.toContain(path);
    }
    for (const path of ["/", "/.", "/..", "/!"]) {
      expect(sanitizeRemoteContent(`Path ${path}`)).toBe(
        "Path <local-path>",
      );
    }
    expect(sanitizeRemoteContent(
      "Inspect /name[1]/file.ts:12, then continue.",
    )).toBe("Inspect <local-path>:12, then continue.");
    expect(sanitizeRemoteContent(
      "Open file:///!private/[tenant]/.env.",
    )).toBe("Open file://<local-path>.");
  });

  it("redacts Windows absolute separator variants recognized by normalization", () => {
    const uncPaths = [
      String.raw`\\server\share\project\.env`,
      "//server/share/project/.env",
      String.raw`\\server/share/project/.env`,
      String.raw`\\server/share\project/.env`,
      String.raw`\\server\\share\file`,
      String.raw`\\server//share\\dir/file`,
    ];
    for (const path of uncPaths) {
      expect(win32.isAbsolute(path)).toBe(true);
      expect(sanitizeRemoteContent(`Path (${path}).`)).toBe(
        "Path (<local-path>).",
      );
    }
    expect(new Set(uncPaths.slice(0, 4).map((path) =>
      win32.normalize(path)))).toEqual(new Set([
      String.raw`\\server\share\project\.env`,
    ]));

    const devicePaths = [
      String.raw`\\?\C:\project/.env`,
      String.raw`\\?\UNC\server\\share/secret.txt`,
      String.raw`\\.\pipe//inertia-test`,
    ];
    for (const path of devicePaths) {
      expect(win32.isAbsolute(path)).toBe(true);
      expect(sanitizeRemoteContent(`Path label:${path}, then done.`)).toBe(
        "Path label:<local-path>, then done.",
      );
    }

    const drivePaths = [
      "C:\\",
      "C:/",
      String.raw`C:\Users\alice\secret.txt`,
      "C:/Users/alice/secret.txt",
      String.raw`C:\dir/file.txt`,
      String.raw`C:\\dir//file.txt`,
      String.raw`\Users\alice\secret.txt`,
      String.raw`\secret`,
      String.raw`\\secret`,
    ];
    for (const path of drivePaths) {
      expect(win32.isAbsolute(path)).toBe(true);
      expect(sanitizeRemoteContent(`Path (${path}).`)).toBe(
        "Path (<local-path>).",
      );
    }
    expect(new Set(drivePaths.slice(2, 4).map((path) =>
      win32.normalize(path)))).toEqual(new Set([
      String.raw`C:\Users\alice\secret.txt`,
    ]));
  });

  it("preserves URLs, relative paths, and ordinary escaped prose", () => {
    const ordinaryText = [
      "https://example.invalid/server/share/project/.env",
      "http://example.invalid/[tenant]/key?next=/private",
      "wss://[::1]/remote",
      "ws://127.0.0.1:8787/remote",
      "workspace/acme/.env",
      "folder/home/alice/file",
      String.raw`folder\home\alice\file`,
      "./relative/[tenant]/key",
      "./relative/(tenant)/key",
      "./relative/{tenant}/key",
      "../relative/file",
      ".hidden/relative/file",
      "café/home/alice/file",
      "cafe\u0301/home/alice/file",
      "𐐀/home/alice/file",
      "项目/文件/notes",
      String.raw`C:relative\file`,
      String.raw`Keep escaped prose \ or \\ intact.`,
      String.raw`Known regex \d+ \w* \s{1,3} or \\d+\\w* stays intact.`,
      String.raw`Punctuated regex \d+, \w*. and \s{1,3}; stays intact.`,
    ].join(" ");
    expect(sanitizeRemoteContent(ordinaryText)).toBe(ordinaryText);
  });

  it("handles surrounding delimiters without treating web URLs as paths", () => {
    const delimitedPaths = [
      ["(/home/alice/.env)", "(<local-path>)"],
      ["[/home/alice/.env]", "[<local-path>]"],
      ["{/home/alice/.env}", "{<local-path>}"],
      ["</home/alice/.env>", "<<local-path>>"],
      ["<C:/Users/alice/secret>", "<<local-path>>"],
      [String.raw`<\\server\share\secret>`, "<<local-path>>"],
    ] as const;
    for (const [input, expected] of delimitedPaths) {
      expect(sanitizeRemoteContent(input)).toBe(expected);
    }
    for (const url of [
      "<https://example.invalid/home/alice/.env>",
      "<wss://[::1]/remote>",
    ]) {
      expect(sanitizeRemoteContent(url)).toBe(url);
    }
  });

  it("treats non-token punctuation as an absolute-path boundary", () => {
    const cases = [
      ["failure)/home/alice/.env", "failure)<local-path>"],
      ["result]/srv/project/file.ts", "result]<local-path>"],
      ["value}/usr/local/private", "value}<local-path>"],
      ["failure./private/secret", "failure.<local-path>"],
      ["quote\"/home/alice/.env", "quote\"<local-path>"],
      ["quote'/home/alice/.env", "quote'<local-path>"],
      ["label:/home/alice/.env", "label:<local-path>"],
      ["list,/home/alice/.env", "list,<local-path>"],
      ["item;/home/alice/.env", "item;<local-path>"],
      [String.raw`failure)\secret`, "failure)<local-path>"],
      [String.raw`result]C:\private\secret`, "result]<local-path>"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(sanitizeRemoteContent(input)).toBe(expected);
    }
  });

  it("bounds and normalizes labels", () => {
    expect(sanitizeRemoteContent(
      "x".repeat(70 * 1024),
      100 * 1024,
    )).toHaveLength(64 * 1024);
    expect(sanitizeRemoteContent(
      "/ ".repeat(40 * 1024),
      100 * 1024,
    )).toHaveLength(64 * 1024);
    const adversarialBoundaries = ":".repeat(64 * 1024);
    const startedAt = performance.now();
    expect(sanitizeRemoteContent(adversarialBoundaries))
      .toBe(adversarialBoundaries);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    const regexToken = String.raw`\d?`.repeat(
      Math.floor((64 * 1024) / String.raw`\d?`.length),
    );
    const regexStartedAt = performance.now();
    expect(sanitizeRemoteContent(regexToken)).toBe(regexToken);
    expect(performance.now() - regexStartedAt).toBeLessThan(2_000);
    const mixedFragment = String.raw`\d?\W+\s{1,3}\B*`;
    const mixedSuffix = " </srv/private/.env>";
    const mixedToken = mixedFragment.repeat(
      Math.floor(((64 * 1024) - mixedSuffix.length) / mixedFragment.length),
    );
    const mixedStartedAt = performance.now();
    expect(sanitizeRemoteContent(`${mixedToken}${mixedSuffix}`)).toBe(
      `${mixedToken} <<local-path>>`,
    );
    expect(performance.now() - mixedStartedAt).toBeLessThan(2_000);
    const interruptedFence = `\`\`\`ts\n${"const bounded = true;\n".repeat(
      4_096,
    )}`;
    const fenceStartedAt = performance.now();
    expect(sanitizeRemoteContent(interruptedFence)).toBe(
      "[Code omitted on Remote Companion]",
    );
    expect(performance.now() - fenceStartedAt).toBeLessThan(2_000);
    const angleProse = "<value> ".repeat(8_192);
    const htmlStartedAt = performance.now();
    expect(sanitizeRemoteContent(angleProse)).toBe(angleProse);
    expect(performance.now() - htmlStartedAt).toBeLessThan(2_000);
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
