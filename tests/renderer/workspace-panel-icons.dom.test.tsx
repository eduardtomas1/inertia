import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { surfaceIcons } from "../../src/renderer/src/components/workspacePanelIcons";

describe("workspace panel surface icons", () => {
  it("draws diff, folder and terminal glyphs for Changes, Files and Terminal", () => {
    const { container } = render(<>{surfaceIcons.changes}{surfaceIcons.files}{surfaceIcons.terminal}</>);
    const glyphs = [...container.querySelectorAll("svg")].map((svg) => svg.getAttribute("class"));
    expect(glyphs).toEqual([
      expect.stringContaining("lucide-file-diff"),
      expect.stringContaining("lucide-folder"),
      expect.stringContaining("lucide-terminal"),
    ]);
    expect(glyphs[2]).not.toContain("lucide-square-terminal");
  });
});
