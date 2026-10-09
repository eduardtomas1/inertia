import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChangedFile } from "../../src/shared/contracts";
import { ChangesPanel } from "../../src/renderer/src/components/ChangesPanel";

const file: ChangedFile = {
  path: "src/app.ts",
  status: "modified",
  insertions: 1,
  deletions: 1,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
};

let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement("style");
  sheet.textContent = readFileSync("src/renderer/src/styles.css", "utf8")
    .replace(/^@import[^;]*;/mu, "")
    .replace(/\s+/gu, " ");
  document.head.append(sheet);
});

afterAll(() => {
  sheet.remove();
});

function renderPanel(summaryLoading: boolean): void {
  render(
    <ChangesPanel
      files={[file]}
      diff={{ patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n", truncated: false, files: [file] }}
      selectedPath="src/app.ts"
      summary={null}
      summaryLoading={summaryLoading}
      onGenerateSummary={vi.fn(async () => undefined)}
      onCancelSummary={vi.fn(async () => undefined)}
      onSelectFile={vi.fn()}
      onAsk={vi.fn(async () => undefined)}
      onRequestRevision={vi.fn(async () => undefined)}
      onRevert={vi.fn(async () => undefined)}
      onSetReviewState={vi.fn(async () => undefined)}
      onCreateNote={vi.fn(async () => undefined)}
      onUpdateNote={vi.fn(async () => undefined)}
      onDeleteNote={vi.fn(async () => undefined)}
      onAddTextToPrompt={vi.fn()}
      onAddToPrompt={vi.fn()}
    />,
  );
}

describe("Changes summary control", () => {
  it("names the idle control with its visible word and sets it in the interface font", () => {
    renderPanel(false);
    const button = screen.getByRole("button", { name: "Summarize changes" });
    expect(button).toHaveTextContent("Summarize");
    expect(getComputedStyle(button).fontFamily).toBe(getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim());
  });

  it("names the running control with its visible word", () => {
    renderPanel(true);
    const button = screen.getByRole("button", { name: "Stop summarizing" });
    expect(button).toHaveTextContent("Stop");
  });
});
