import { describe, expect, it } from "vitest";

import {
  COMMIT_MESSAGE_MAX_LENGTH,
  commitSubject,
  draftCommitMessage,
  type CommitDraftFile,
} from "../../src/renderer/src/lib/commitMessageDraft";

function file(path: string, status = "modified", untracked = false): CommitDraftFile {
  return { path, status, untracked };
}

describe("draftCommitMessage", () => {
  it("uses the first summary sentence as the subject and the rest as the body", () => {
    expect(draftCommitMessage({
      summary: "Adds retry\nhandling to startup.  The loader waits for the socket! It also logs failures.",
      files: [file("a.ts")],
      selectedPaths: ["a.ts"],
    })).toBe("Adds retry handling to startup\n\nThe loader waits for the socket! It also logs failures.");
    expect(draftCommitMessage({ summary: "Is this safe? Yes.", files: [], selectedPaths: [] }))
      .toBe("Is this safe?\n\nYes.");
    expect(draftCommitMessage({ summary: "Single clause without a full stop", files: [], selectedPaths: [] }))
      .toBe("Single clause without a full stop");
    expect(draftCommitMessage({ summary: "Version 1.2 ships now.", files: [], selectedPaths: [] }))
      .toBe("Version 1.2 ships now");
  });

  it("falls back to selected paths when the summary is missing or blank", () => {
    const files = [
      file("src/ui/app.ts"),
      file("src/ui/old.ts", "deleted"),
      file("src/ui/new.ts", "untracked", true),
      file("README.md"),
    ];
    expect(draftCommitMessage({
      summary: "   ",
      files,
      selectedPaths: ["src/ui/new.ts", "src/ui/app.ts", "src/ui/old.ts"],
    })).toBe([
      "Update src/ui",
      "",
      "- Modified: src/ui/app.ts",
      "- Deleted: src/ui/old.ts",
      "- Added: src/ui/new.ts",
    ].join("\n"));
    expect(draftCommitMessage({ files, selectedPaths: ["README.md", "src/ui/app.ts"] }))
      .toBe("Update 2 files\n\n- Modified: src/ui/app.ts\n- Modified: README.md");
    expect(draftCommitMessage({ files, selectedPaths: ["README.md"] }))
      .toBe("Update README.md\n\n- Modified: README.md");
  });

  it("finds a common folder by whole path segments", () => {
    expect(commitSubject(draftCommitMessage({
      files: [file("src/app/a.ts"), file("src/application/b.ts")],
      selectedPaths: ["src/app/a.ts", "src/application/b.ts"],
    }))).toBe("Update src");
  });

  it("labels every status and bounds long file lists and total length", () => {
    const statuses = ["added", "renamed", "copied", "type-changed", "unmerged", "unknown"];
    expect(draftCommitMessage({
      files: statuses.map((status) => file(`${status}.txt`, status)),
      selectedPaths: statuses.map((status) => `${status}.txt`),
    }).split("\n").slice(2)).toEqual([
      "- Added: added.txt",
      "- Renamed: renamed.txt",
      "- Copied: copied.txt",
      "- Type changed: type-changed.txt",
      "- Unmerged: unmerged.txt",
      "- Changed: unknown.txt",
    ]);

    const many = Array.from({ length: 75 }, (_, index) => file(`dir/${"x".repeat(300)}-${index}.ts`));
    const draft = draftCommitMessage({ files: many, selectedPaths: many.map(({ path }) => path) });
    expect(draft.length).toBeLessThanOrEqual(COMMIT_MESSAGE_MAX_LENGTH);
    expect(draftCommitMessage({
      files: many.slice(0, 60).map((entry, index) => ({ ...entry, path: `d/${index}.ts` })),
      selectedPaths: many.slice(0, 60).map((_, index) => `d/${index}.ts`),
    })).toContain("- …and 10 more");
  });

  it("returns an empty draft when there is no local evidence", () => {
    expect(draftCommitMessage({ summary: null, files: [file("a.ts")], selectedPaths: [] })).toBe("");
  });
});
