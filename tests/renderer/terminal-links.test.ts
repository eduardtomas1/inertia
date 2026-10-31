import { afterEach, describe, expect, it, vi } from "vitest";
import type { IBufferCell, ILink } from "@xterm/xterm";

import type { TerminalPathResolution } from "../../src/shared/contracts/terminal-links";
import {
  completeTerminalPathCandidates,
  createTerminalPathLinkProvider,
  createTerminalPathResolver,
  MAX_TERMINAL_PATH_CANDIDATES_PER_LINE,
  openTerminalWebLink,
  readTerminalLine,
  TERMINAL_LINK_HANDLER,
  terminalPathCandidates,
} from "../../src/renderer/src/utils/terminalLinks";

type FakeCell = { chars: string; width: number };

/** Builds an xterm-like buffer from rows of cells; `wrapped` marks soft wraps. */
function fakeBuffer(rows: Array<{ cells: FakeCell[]; wrapped?: boolean }>, columns: number) {
  const current = { chars: "", width: 1 };
  const nullCell = {
    getChars: () => current.chars,
    getWidth: () => current.width,
  } as unknown as IBufferCell;
  return {
    getNullCell: () => nullCell,
    getLine: (row: number) => {
      const line = rows[row];
      if (!line) return undefined;
      return {
        isWrapped: line.wrapped === true,
        length: columns,
        getCell: (x: number) => {
          const cell = line.cells[x] ?? { chars: "", width: 1 };
          current.chars = cell.chars;
          current.width = cell.width;
          return nullCell;
        },
      };
    },
  };
}

const textRow = (text: string, wrapped = false) => ({
  cells: [...text].map((chars) => ({ chars, width: 1 })),
  wrapped,
});

const resolution = (projectPath: string, line: number | null = null, column: number | null = null): TerminalPathResolution => ({
  projectPath, line, column,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal path candidates", () => {
  it.each([
    ["error in src/app.ts:12:3 here", ["src/app.ts:12:3"]],
    ["src/app.ts(12,3): error TS2322", ["src/app.ts(12,3)"]],
    ["at Object.<anonymous> (/home/me/repo/src/a.js:10:5)", ["/home/me/repo/src/a.js:10:5"]],
    ["  C:\\repo\\src\\app.ts:4:2 failed", ["C:\\repo\\src\\app.ts:4:2"]],
    ["see README.md, then 'docs/guide.md'.", ["README.md", "docs/guide.md"]],
    ["./scripts/build.mjs", ["./scripts/build.mjs"]],
    ["\"src/a b.ts\"", ["src/a", "b.ts"]],
  ])("finds %j", (line, expected) => {
    expect(terminalPathCandidates(line).map(({ text }) => text)).toEqual(expected);
  });

  it.each([
    "https://example.com/src/app.ts:3",
    "see https://example.com and http://x.test/a.ts",
    "version 1.2.3 and 10.5%",
    "// just a comment",
    "~/notes.md",
    "--config=foo.json",
    "/ and \\ and ../",
    "plain words only",
  ])("ignores %j", (line) => {
    expect(terminalPathCandidates(line)).toEqual([]);
  });

  it("reports offsets into the scanned text", () => {
    const [candidate] = terminalPathCandidates("x (src/app.ts:4).");
    expect(candidate).toEqual({ text: "src/app.ts:4", start: 3, end: 15 });
  });
});

describe("readTerminalLine", () => {
  it("joins soft-wrapped rows and maps characters to their cells", () => {
    const buffer = fakeBuffer([textRow("prefix"), textRow("ab src/"), textRow("app.ts:", true), textRow("2", true)], 7);
    for (const row of [1, 2, 3]) {
      const line = readTerminalLine(buffer, row, 7);
      expect(line.text.trimEnd()).toBe("ab src/app.ts:2");
      expect(line.cells[3]).toEqual({ x: 4, y: 2, width: 1 });
      expect(line.cells[7]).toEqual({ x: 1, y: 3, width: 1 });
      expect(line.cells[14]).toEqual({ x: 1, y: 4, width: 1 });
    }
  });

  it("skips the trailing half of wide characters", () => {
    const buffer = fakeBuffer([{
      cells: [
        { chars: "界", width: 2 }, { chars: "", width: 0 },
        { chars: " ", width: 1 }, { chars: "a", width: 1 },
      ],
    }], 4);
    const line = readTerminalLine(buffer, 0, 4);
    expect(line.text).toBe("界 a");
    expect(line.cells.map(({ x }) => x)).toEqual([1, 3, 4]);
  });
});

describe("long wrapped lines", () => {
  const wrappedRows = (count: number, text: (row: number) => string) =>
    Array.from({ length: count }, (_, row) => textRow(text(row), row > 0));

  it("drops a token cut by the look-back limit but keeps whole ones after it", () => {
    const rows = wrappedRows(40, (row) => (row === 30 ? "ry/file.ts src/b.ts" : "abcdefghij").padEnd(20, row === 30 ? " " : "x"));
    const buffer = fakeBuffer(rows, 20);
    const line = readTerminalLine(buffer, 30, 20);
    expect(line.cutAtStart).toBe(true);
    expect(line.text.startsWith("abcdefghij")).toBe(true);
    const tokens = completeTerminalPathCandidates({ ...line, text: "ry/file.ts src/b.ts", cells: line.cells });
    expect(tokens.map(({ text }) => text)).toEqual(["src/b.ts"]);
    expect(completeTerminalPathCandidates({ ...line, text: " ry/file.ts src/b.ts" }).map(({ text }) => text))
      .toEqual(["ry/file.ts", "src/b.ts"]);
  });

  it("drops a token cut by the read-ahead limit", () => {
    const line = { text: "src/a.ts lib/partia", cells: [], cutAtStart: false, cutAtEnd: true };
    expect(completeTerminalPathCandidates(line).map(({ text }) => text)).toEqual(["src/a.ts"]);
    expect(completeTerminalPathCandidates({ ...line, text: "src/a.ts lib/partia " }).map(({ text }) => text))
      .toEqual(["src/a.ts", "lib/partia"]);
    expect(completeTerminalPathCandidates({ ...line, cutAtEnd: false }).map(({ text }) => text))
      .toEqual(["src/a.ts", "lib/partia"]);
  });

  it("marks a line that starts at an unwrapped row as complete", () => {
    const buffer = fakeBuffer([textRow("src/app.ts"), textRow(" next", true)], 10);
    expect(readTerminalLine(buffer, 1, 10)).toMatchObject({ cutAtStart: false, cutAtEnd: false });
  });
});

describe("terminal path resolver", () => {
  it("caches resolutions and expires misses", async () => {
    let now = 0;
    const lookup = vi.fn(async (text: string) => (text === "src/a.ts" ? resolution("src/a.ts") : null));
    const resolver = createTerminalPathResolver(lookup, { now: () => now, missingTtlMs: 1_000 });
    await expect(resolver.resolve("src/a.ts")).resolves.toEqual(resolution("src/a.ts"));
    await expect(resolver.resolve("src/a.ts")).resolves.toEqual(resolution("src/a.ts"));
    await expect(resolver.resolve("missing.ts")).resolves.toBeNull();
    await expect(resolver.resolve("missing.ts")).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    now = 2_000;
    await resolver.resolve("missing.ts");
    await resolver.resolve("src/a.ts");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("does not cache failed lookups", async () => {
    const lookup = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(resolution("src/a.ts"));
    const resolver = createTerminalPathResolver(lookup);
    await expect(resolver.resolve("src/a.ts")).resolves.toBeNull();
    await expect(resolver.resolve("src/a.ts")).resolves.toEqual(resolution("src/a.ts"));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("caps concurrent lookups and drops work beyond the queue", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const lookup = vi.fn((text: string) => new Promise<TerminalPathResolution | null>((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      pending.push(() => {
        active -= 1;
        resolve(resolution(text));
      });
    }));
    const resolver = createTerminalPathResolver(lookup, { maxConcurrent: 2, maxQueued: 1 });
    const results = ["a.ts", "b.ts", "c.ts", "d.ts"].map((text) => resolver.resolve(text));
    await expect(results[3]).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    while (pending.length > 0) {
      pending.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await expect(Promise.all(results.slice(0, 3))).resolves.toEqual([
      resolution("a.ts"), resolution("b.ts"), resolution("c.ts"),
    ]);
    expect(peak).toBe(2);
  });

  it("bounds the cache and ignores oversized or empty tokens", async () => {
    const lookup = vi.fn(async (text: string) => resolution(text));
    const resolver = createTerminalPathResolver(lookup, { maxEntries: 2 });
    await resolver.resolve("a.ts");
    await resolver.resolve("b.ts");
    await resolver.resolve("c.ts");
    await resolver.resolve("a.ts");
    expect(lookup).toHaveBeenCalledTimes(4);
    await expect(resolver.resolve("")).resolves.toBeNull();
    await expect(resolver.resolve("x".repeat(2_000))).resolves.toBeNull();
    resolver.dispose();
    await expect(resolver.resolve("b.ts")).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("settles queued lookups with nothing on dispose and ignores late answers", async () => {
    const pending: Array<() => void> = [];
    const lookup = vi.fn((text: string) => new Promise<TerminalPathResolution | null>((resolve) => {
      pending.push(() => resolve(resolution(text)));
    }));
    const resolver = createTerminalPathResolver(lookup, { maxConcurrent: 1, maxQueued: 4 });
    const running = resolver.resolve("a.ts");
    const queued = resolver.resolve("b.ts");
    resolver.dispose();
    await expect(queued).resolves.toBeNull();
    pending.shift()!();
    await expect(running).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe("terminal path link provider", () => {
  const provide = (provider: ReturnType<typeof createTerminalPathLinkProvider>, row: number) => (
    new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(row, resolve))
  );

  it("links only resolved files, with ranges on the hovered row", async () => {
    const terminal = {
      cols: 40,
      buffer: { active: fakeBuffer([textRow("FAIL src/app.ts:3:5 and src/missing.ts:1")], 40) },
    };
    const lookup = vi.fn(async (text: string) => (text === "src/app.ts:3:5" ? resolution("src/app.ts", 3, 5) : null));
    const open = vi.fn();
    const provider = createTerminalPathLinkProvider(terminal as never, createTerminalPathResolver(lookup), open);
    const links = await provide(provider, 1);
    expect(lookup.mock.calls.map(([text]) => text)).toEqual(["src/app.ts:3:5", "src/missing.ts:1"]);
    expect(links).toHaveLength(1);
    expect(links![0]!.text).toBe("src/app.ts:3:5");
    expect(links![0]!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 19, y: 1 } });
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;
    links![0]!.activate(event, links![0]!.text);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(resolution("src/app.ts", 3, 5));
  });

  it("asks for nothing when disabled or when a line has no candidates", async () => {
    const terminal = { cols: 20, buffer: { active: fakeBuffer([textRow("src/app.ts"), textRow("hello")], 20) } };
    const lookup = vi.fn(async () => resolution("src/app.ts"));
    const resolver = createTerminalPathResolver(lookup);
    await expect(provide(createTerminalPathLinkProvider(terminal as never, resolver, vi.fn(), () => false), 1))
      .resolves.toBeUndefined();
    await expect(provide(createTerminalPathLinkProvider(terminal as never, resolver, vi.fn()), 2))
      .resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never calls back after it is disposed", async () => {
    const terminal = { cols: 20, buffer: { active: fakeBuffer([textRow("src/app.ts")], 20) } };
    let answer!: (value: TerminalPathResolution | null) => void;
    const lookup = vi.fn(() => new Promise<TerminalPathResolution | null>((resolve) => { answer = resolve; }));
    const provider = createTerminalPathLinkProvider(terminal as never, createTerminalPathResolver(lookup), vi.fn());
    const callback = vi.fn();
    provider.provideLinks(1, callback);
    provider.dispose();
    answer(resolution("src/app.ts"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).not.toHaveBeenCalled();
    provider.provideLinks(1, callback);
    expect(callback).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("bounds candidates per line", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `f${index}.ts`).join(" ");
    const terminal = { cols: text.length, buffer: { active: fakeBuffer([textRow(text)], text.length) } };
    const lookup = vi.fn(async () => null);
    await provide(createTerminalPathLinkProvider(terminal as never, createTerminalPathResolver(lookup), vi.fn()), 1);
    expect(lookup).toHaveBeenCalledTimes(MAX_TERMINAL_PATH_CANDIDATES_PER_LINE);
  });
});

describe("terminal web links", () => {
  it("opens http(s) links through the desktop bridge only", () => {
    const openExternal = vi.fn(async () => undefined);
    const windowOpen = vi.fn();
    vi.stubGlobal("window", { inertia: { openExternal }, open: windowOpen });
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;
    openTerminalWebLink(event, "https://example.com/a?b=1");
    openTerminalWebLink(event, "javascript:alert(1)");
    openTerminalWebLink(event, "file:///etc/passwd");
    openTerminalWebLink(event, "not a url");
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/a?b=1");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("gives OSC 8 hyperlinks the same policy and no other protocols", () => {
    const openExternal = vi.fn(async () => undefined);
    vi.stubGlobal("window", { inertia: { openExternal }, open: vi.fn() });
    expect(TERMINAL_LINK_HANDLER.allowNonHttpProtocols).toBe(false);
    const event = { preventDefault: vi.fn() } as unknown as MouseEvent;
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
    TERMINAL_LINK_HANDLER.activate(event, "http://localhost:5173/", range);
    TERMINAL_LINK_HANDLER.activate(event, "vscode://file/etc/passwd", range);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("http://localhost:5173/");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});
