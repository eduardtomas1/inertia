import { describe, expect, it } from "vitest";

import { CodexCommandOutput } from "../../src/server/codex/app-server-command-output";

describe("Codex command output lines", () => {
  it("releases complete lines and holds the unfinished one", () => {
    const output = new CodexCommandOutput();

    expect(output.append("item", "first\nsec")).toBe("first\n");
    expect(output.append("item", "ond")).toBe("");
    expect(output.append("item", "\nthird")).toBe("second\n");
    expect(output.release("item")).toBe("third");
    expect(output.release("item")).toBe("");
  });

  it("treats a carriage return followed by more output as a line end but holds a trailing one", () => {
    const output = new CodexCommandOutput();

    expect(output.append("item", "10%\r20%\r")).toBe("10%\r");
    expect(output.append("item", "\n")).toBe("20%\r\n");
  });

  it("releases a long unfinished line at its last space, or whole when it has none", () => {
    const output = new CodexCommandOutput();
    const words = `${"word ".repeat(220)}tail`;

    expect(output.append("spaced", words)).toBe("word ".repeat(220));
    expect(output.release("spaced")).toBe("tail");
    expect(output.append("solid", "x".repeat(1_100))).toBe("x".repeat(1_100));
  });

  it("holds an open private key block until it ends, up to 16 KiB", () => {
    const output = new CodexCommandOutput();
    const begin = "-----BEGIN PRIVATE KEY-----\n";

    expect(output.append("key", `${begin}MIIEv\n`)).toBe("");
    expect(output.append("key", "QIBADAN\n")).toBe("");
    expect(output.append("key", "-----END PRIVATE KEY-----\nnext"))
      .toBe(`${begin}MIIEv\nQIBADAN\n-----END PRIVATE KEY-----\n`);
    expect(output.append("long", `${begin}${"A".repeat(64)}\n`))
      .toBe("");
    expect(output.append("long", `${"A".repeat(64)}\n`.repeat(256)).length)
      .toBeGreaterThan(16 * 1_024);
  });

  it("completes with the held line, the unseen ending, or a repeat when the output differs", () => {
    const output = new CodexCommandOutput();

    expect(output.complete("unstreamed", "all")).toBeNull();
    output.append("ended", "one\ntw");
    expect(output.complete("ended", "one\ntwo\nthree\n"))
      .toEqual({ delta: "two\nthree\n", repeatOutput: false });
    output.append("shorter", "one\ntwo\n");
    expect(output.complete("shorter", "one\n"))
      .toEqual({ delta: "", repeatOutput: false });
    output.append("rewritten", "building\nlin");
    expect(output.complete("rewritten", "[trimmed]\nbuilt everything\n"))
      .toEqual({ delta: "lin", repeatOutput: true });
    expect(output.complete("ended", "one\n")).toBeNull();
  });
});
