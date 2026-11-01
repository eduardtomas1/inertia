import { describe, expect, it } from "vitest";

import {
  FILE_CHIP_FOLDER_HINT_LENGTH,
  MAX_FILE_CHIP_TOKEN_LENGTH,
  fileChipReference,
  middleTruncate,
} from "../../src/renderer/src/utils/fileChipReference";

describe("file chip detection", () => {
  it("reads the basename, folder and location of a repository path", () => {
    expect(fileChipReference("src/renderer/src/App.tsx:42:7")).toEqual({
      token: "src/renderer/src/App.tsx:42:7",
      path: "src/renderer/src/App.tsx",
      name: "App.tsx",
      folder: "src/renderer/src",
      location: { startLine: 42, startColumn: 7, endLine: 42 },
      locationLabel: ":42:7",
      kind: "code",
    });
    expect(fileChipReference("docs/RELEASING.md:12")).toMatchObject({
      path: "docs/RELEASING.md",
      location: { startLine: 12, endLine: 12 },
      locationLabel: ":12",
      kind: "text",
    });
    expect(fileChipReference("package.json")).toEqual({
      token: "package.json",
      path: "package.json",
      name: "package.json",
      folder: "",
      locationLabel: "",
      kind: "config",
    });
  });

  it.each([
    ["src/main/index.ts", "code"],
    ["src\\main\\index.ts", "code"],
    ["./scripts/build.mjs", "code"],
    ["/workspace/project/src/app.ts", "code"],
    ["src/../README.md", "text"],
    ["app/[id]/page.tsx", "code"],
    ["routes/$slug.tsx", "code"],
    ["packages/@scope/pkg/index.cjs", "code"],
    ["notes.TXT", "text"],
    ["logo.SVG", "image"],
    ["screenshot.png", "image"],
    ["photo.jpg", "image"],
    ["spinner.gif", "image"],
    ["config.yml", "config"],
    ["compose.yaml", "config"],
    ["Cargo.toml", "config"],
    ["Cargo.lock", "config"],
    [".env", "config"],
    [".gitignore", "config"],
    [".editorconfig", "config"],
    ["Dockerfile", "config"],
    ["app.dockerfile", "config"],
    ["schema.sql", "code"],
    ["install.ps1", "code"],
    ["run.sh", "code"],
    ["main.rs", "code"],
    ["main.go", "code"],
    ["Main.java", "code"],
    ["Main.kt", "code"],
    ["App.swift", "code"],
    ["util.c", "code"],
    ["util.h", "code"],
    ["util.cpp", "code"],
    ["util.hpp", "code"],
    ["Program.cs", "code"],
    ["app.rb", "code"],
    ["index.php", "code"],
    ["index.html", "code"],
    ["theme.scss", "code"],
    ["app.py:3", "code"],
    ["README.md", "text"],
    ["index.ts", "code"],
    ["next.config.js", "code"],
    ["src/Node.js", "code"],
    ["lib/Vue.js", "code"],
    ["CHANGELOG.MD", "text"],
  ])("accepts %s", (token, kind) => {
    expect(fileChipReference(token)?.kind).toBe(kind);
  });

  it.each([
    ["an empty token", ""],
    ["whitespace", "src/my file.ts"],
    ["a tab", "src/app.ts\t"],
    ["a URL", "https://example.com/app.ts"],
    ["a custom scheme URL", "vscode://file/src/app.ts"],
    ["a web host path", "github.com/org/repo"],
    ["a www host", "www.example.org/index.html"],
    ["a flag", "--config=app.json"],
    ["a short flag", "-p/tmp"],
    ["a home path", "~/project/app.ts"],
    ["a Windows absolute path", "C:\\Users\\me\\app.ts"],
    ["a Windows forward-slash path", "D:/work/app.ts"],
    ["a drive-relative path", "C:app.ts"],
    ["a rooted Windows path", "\\work\\app.ts"],
    ["a UNC path", "\\\\server\\share\\app.ts"],
    ["a protocol-relative path", "//server/share/app.ts"],
    ["an escaping parent", "../secrets.env"],
    ["a nested escaping parent", "src/../../secrets.env"],
    ["an absolute escaping parent", "/../etc/passwd.txt"],
    ["a bare parent", "src/.."],
    ["a bare current directory", "src/."],
    ["a trailing slash directory", "src/components/"],
    ["a trailing backslash directory", "src\\components\\"],
    ["an empty segment", "src//app.ts"],
    ["a root", "/"],
    ["a basename without an allowed extension", "notes.docx"],
    ["a directory", "src/renderer"],
    ["a nested directory", "src/components"],
    ["a rooted directory", "/workspace/project"],
    ["a folder of rules", "Makefile/rules"],
    ["a JSON MIME type", "application/json"],
    ["an HTML MIME type", "text/html"],
    ["an image MIME type", "image/png"],
    ["a vendor MIME type", "application/vnd.api+json"],
    ["a scoped package", "@types/node"],
    ["a scoped package entry", "@scope/pkg/index.ts"],
    ["a remote branch", "origin/main"],
    ["a feature branch", "feat/visual-thread-feel"],
    ["an API route", "/api/users"],
    ["a nested API route", "/api/v1/users/42"],
    ["an ISO date", "2026-10-31"],
    ["a slashed date", "10/31/2026"],
    ["a dotted date", "2026.10.31"],
    ["a library name", "Node.js"],
    ["another library name", "Vue.js"],
    ["a framework name", "Next.js"],
    ["a library name on a line", "Three.js:4"],
    ["a version number", "v1.2.3"],
    ["an extension alone", ".ts"],
    ["a dotfile without an allowed name", ".npmrc"],
    ["a trailing dot", "file."],
    ["a word", "README"],
    ["a line on a word", "README:12"],
    ["a zero line", "src/app.ts:0"],
    ["a ten-digit line", "src/app.ts:1234567890"],
    ["a line range", "src/app.ts:4-7"],
    ["a glob", "src/**/*.ts"],
    ["a brace glob", "src/{a,b}.ts"],
    ["a generic type", "Map<string>/x.ts"],
    ["a query", "src/app.ts?raw"],
    ["a fragment", "src/app.ts#L4"],
    ["an encoded path", "src/my%20file.ts"],
    ["a quote", "src/\"app\".ts"],
    ["a pipe", "a|b/c.ts"],
    ["a colon in a segment", "src/a:b/c.ts"],
    ["a control character", "src/app\u0000.ts"],
  ])("rejects %s", (_label, token) => {
    expect(fileChipReference(token)).toBeNull();
  });

  it("bounds the token length at 200 characters", () => {
    const folder = "a/".repeat(97);
    const exact = `${folder}abc.ts`;
    expect(exact).toHaveLength(MAX_FILE_CHIP_TOKEN_LENGTH);
    expect(fileChipReference(exact)?.name).toBe("abc.ts");
    expect(fileChipReference(`${folder}abcd.ts`)).toBeNull();
    expect(fileChipReference(`${"x".repeat(197)}.ts`)).not.toBeNull();
    expect(fileChipReference(`${"x".repeat(198)}.ts`)).toBeNull();
  });

  it("removes a leading current-directory segment from the folder hint", () => {
    expect(fileChipReference("./src/app.ts")?.folder).toBe("src");
    expect(fileChipReference("./app.ts")?.folder).toBe("");
    expect(fileChipReference(".\\src\\app.ts")?.folder).toBe("src");
    expect(fileChipReference("/app.ts")?.folder).toBe("/");
    expect(fileChipReference("src\\main\\index.ts")?.folder).toBe("src\\main");
  });

  it("middle-truncates long folder hints to the hint length", () => {
    expect(middleTruncate("src/renderer")).toBe("src/renderer");
    const long = "src/renderer/src/components/response-timeline/nested/deeper";
    const hint = middleTruncate(long);
    expect(Array.from(hint)).toHaveLength(FILE_CHIP_FOLDER_HINT_LENGTH);
    expect(hint.startsWith(long.slice(0, 19))).toBe(true);
    expect(hint.endsWith(long.slice(-20))).toBe(true);
    expect(hint).toContain("…");
    expect(middleTruncate("ä".repeat(50))).toBe(`${"ä".repeat(19)}…${"ä".repeat(20)}`);
  });
});
