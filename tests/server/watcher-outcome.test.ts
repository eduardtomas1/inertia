import { describe, expect, it } from "vitest";

import { MAX_WATCHER_FINDING_BYTES, MAX_WATCHER_NOTE_CHARS } from "../../src/shared/watcher";
import {
  classifyWatcherReply,
  findingPreview,
} from "../../src/server/runtime/watcher/watcher-outcome";

describe("classifyWatcherReply", () => {
  it.each([
    "SILENT",
    "SILENT.",
    "  SILENT \n",
    "**SILENT**",
    "`SILENT`",
    "\"SILENT\"",
    "'SILENT.'",
    "“SILENT”",
    "**`SILENT`**",
    "__SILENT__",
  ])("treats %j as silent", (reply) => {
    expect(classifyWatcherReply(reply, "completed")).toBe("silent");
  });

  it.each([
    "silent",
    "SILENT!",
    "SILENT..",
    "SILENT — nothing to add",
    "Nothing to report. SILENT",
    "SILENT\nBut also: the migration is missing a test.",
    "**SILENT",
    "S I L E N T",
    "SILENT".repeat(20),
  ])("treats %j as a finding", (reply) => {
    expect(classifyWatcherReply(reply, "completed")).toBe("finding");
  });

  it("treats an empty reply as silent only on a completed turn", () => {
    expect(classifyWatcherReply(null, "completed")).toBe("silent");
    expect(classifyWatcherReply("   \n", "completed")).toBe("silent");
    expect(classifyWatcherReply(null, "failed")).toBe("finding");
    expect(classifyWatcherReply("", "interrupted")).toBe("finding");
  });
});

describe("findingPreview", () => {
  it("keeps a short finding as written, trimmed", () => {
    expect(findingPreview("  - **High**: missing test in src/a.ts\n")).toBe("- **High**: missing test in src/a.ts");
  });

  it("stays within the character and byte limits", () => {
    const ascii = findingPreview("x".repeat(MAX_WATCHER_NOTE_CHARS + 50));
    expect(ascii.length).toBeLessThanOrEqual(MAX_WATCHER_NOTE_CHARS);
    expect(ascii.endsWith("[Shortened by Inertia.]")).toBe(true);

    const wide = findingPreview("語".repeat(MAX_WATCHER_NOTE_CHARS));
    expect(Buffer.byteLength(wide, "utf8")).toBeLessThanOrEqual(MAX_WATCHER_FINDING_BYTES);
    expect(wide.length).toBeLessThanOrEqual(MAX_WATCHER_NOTE_CHARS);
    expect(Buffer.from(wide, "utf8").toString("utf8")).toBe(wide);
  });

  it("never splits a surrogate pair", () => {
    for (const prefix of ["", "a", "ab", "abc"]) {
      const preview = findingPreview(`${prefix}${"😀".repeat(MAX_WATCHER_NOTE_CHARS)}`);
      expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
      expect(preview).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(MAX_WATCHER_FINDING_BYTES);
    }
  });

  it("replaces NUL bytes", () => {
    expect(findingPreview("a\0b")).toBe("a�b");
  });
});
