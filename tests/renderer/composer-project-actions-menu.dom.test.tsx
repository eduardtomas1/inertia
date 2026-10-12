import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProjectAction } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";

import { readSourceText } from "../helpers/source-text";
import { composerProps, conversation, openComposerTools } from "./composer-fixtures";

const actions: ProjectAction[] = [
  { id: "test", label: "Test", command: "npm test", preview: false },
  { id: "lint", label: "Lint", command: "npm run lint", preview: false },
  { id: "dev", label: "Dev server", command: "npm run dev", preview: true },
];

afterEach(() => {
  window.localStorage.clear();
});

describe("composer project actions menu", () => {
  it("opens from the keyboard and moves focus through its actions", async () => {
    render(<Composer {...composerProps(conversation("project-actions-keyboard"), { actions })} />);
    openComposerTools();
    const trigger = screen.getByRole("button", { name: "Open project actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Project actions" });
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2]!, { key: "Home" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(items[2]).toHaveFocus();
  });

  it("opens on the last action with ArrowUp", async () => {
    render(<Composer {...composerProps(conversation("project-actions-keyboard-up"), { actions })} />);
    openComposerTools();
    const trigger = screen.getByRole("button", { name: "Open project actions" });

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const menu = await screen.findByRole("menu", { name: "Project actions" });
    const items = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(items[2]).toHaveFocus());
  });

  it("hides the inline actions control only at widths where the More menu offers it", () => {
    const css = readSourceText("src/renderer/src/styles.css");
    const blocks = [...css.matchAll(/^@container \(max-width: (\d+)px\) \{\n([\s\S]*?)\n\}$/gmu)]
      .map(([, width, body]) => ({ width: Number(width), body: body! }));
    const moreWidths = blocks
      .filter(({ body }) => /\.composer-more-control \{\n\s+display: block;/u.test(body))
      .map(({ width }) => width);
    const hiddenWidths = blocks
      .filter(({ body }) => /\.composer-action-control[^{]*\{\n\s+display: none;/u.test(body))
      .map(({ width }) => width);
    expect(moreWidths).toHaveLength(1);
    expect(hiddenWidths.length).toBeGreaterThan(0);
    expect(Math.max(...hiddenWidths)).toBeLessThanOrEqual(moreWidths[0]!);
  });
});
