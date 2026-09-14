import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodedLocalFilePath, localFileUrl, parseLocalFileUrl } from "../../src/shared/local-file-url";

describe("desktop file URLs", () => {
  it.each([
    ["/home/example/Desktop/My workflow.json", "file:///home/example/Desktop/My%20workflow.json", false],
    ["/Users/example/文档/name#part?100%.md", "file:///Users/example/%E6%96%87%E6%A1%A3/name%23part%3F100%25.md", false],
    ["C:\\Other Folder\\notes.json", "file:///C:/Other%20Folder/notes.json", true],
    ["\\\\server\\share\\My notes.md", "file://server/share/My%20notes.md", true],
  ] as const)("round-trips %s through the native URL parser", (path, href, windows) => {
    expect(localFileUrl(path)).toBe(href);
    const url = parseLocalFileUrl(href);
    expect(url).not.toBeNull();
    expect(fileURLToPath(url!, { windows })).toBe(path);
    expect(decodeURIComponent(encodedLocalFilePath(url!))).toBe(path.replace(/\\/gu, "/"));
  });

  it.each([
    "javascript:alert(1)", "data:text/html,x", "https://example.test/file.json",
    "file:///tmp/a%00.json", "file:///tmp/a%0A.json", "file:///tmp/a\r.json",
    "file:///tmp/a%2Fetc", "file:///tmp/a%5Cetc", "file:///tmp/%ZZ",
    "file://user:password@host/share", "file://host:42/share", "file:///tmp/a?command=run",
    "file:///" + "a".repeat(16_384), null, {},
  ])("rejects invalid file URL %s", (href) => {
    expect(parseLocalFileUrl(href)).toBeNull();
  });

  it.each(["relative/file.json", "/tmp/a\0.json", "/tmp/\ud800", "//user@host/share"]) (
    "does not construct a file URL for %s", (path) => expect(localFileUrl(path)).toBeNull(),
  );

  it("preserves escaped filename delimiters and source fragments", () => {
    const url = parseLocalFileUrl("file:///tmp/name%23part%3A42.md#L12")!;
    expect(encodedLocalFilePath(url)).toBe("/tmp/name%23part%3A42.md");
    expect(url.hash).toBe("#L12");
  });
});
