import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GitQuickActionIcon } from "../../src/renderer/src/components/workspace-header/GitActionsControl";
import { readSourceText } from "../helpers/source-text";

describe("workspace header glyphs", () => {
  it("draws Sync branch with its own glyph instead of an info mark", () => {
    const { container } = render(<GitQuickActionIcon quickAction={{ label: "Sync branch", disabled: true, kind: "show_hint", hint: "Diverged" }} />);
    expect(container.querySelector(".lucide-arrow-down-up")).not.toBeNull();
    expect(container.querySelector(".lucide-info")).toBeNull();
  });

  it("opens checkouts with distinct glyphs and hints without native titles", () => {
    for (const path of ["src/renderer/src/components/workspace-header/OpenInControl.tsx", "src/renderer/src/components/workspace-header/HeaderActionMenus.tsx"]) {
      const source = readSourceText(path);
      expect(source).toMatch(/folder: ExternalLink,\n  "file-manager": FolderOpen,\n  files: Folder,/u);
      expect(source).not.toContain("title={disabled ?");
    }
  });
});
