import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ACCESS_MODE_LABELS, INTERACTION_MODE_LABELS, watcherAccessLabel } from "../../src/shared/access-labels";
import type { AccessMode, InteractionMode } from "../../src/shared/contracts";

describe("access labels", () => {
  it("labels a watcher's access with the composer's mode and access wording", () => {
    const conversation = { interactionMode: "build" as const, accessMode: "full" as const };
    expect(watcherAccessLabel({ readOnly: true }, conversation)).toBe("Read-only");
    expect(watcherAccessLabel({ readOnly: true }, null)).toBe("Read-only");
    expect(watcherAccessLabel({ readOnly: false }, null)).toBe("Chat access");
    expect(watcherAccessLabel({ readOnly: false }, conversation)).toBe("Build · Full access");
    expect(watcherAccessLabel({ readOnly: false }, { interactionMode: "plan", accessMode: "auto-edit" })).toBe("Plan · Auto-accept edits");
    expect(watcherAccessLabel({ readOnly: false }, { interactionMode: "build", accessMode: "supervised" })).toBe("Build · Supervised");
  });

  it("labels every mode and access level the contracts know", () => {
    const modes: Record<InteractionMode, string> = INTERACTION_MODE_LABELS;
    const access: Record<AccessMode, string> = ACCESS_MODE_LABELS;
    expect(Object.keys(modes).sort()).toEqual(["build", "plan"]);
    expect(Object.keys(access).sort()).toEqual(["auto-edit", "full", "supervised"]);
  });

  it("stays free of runtime and zod imports so small renderer chunks can use it", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../src/shared/access-labels.ts"), "utf8");
    expect(source.split("\n").filter((line) => line.startsWith("import "))).toEqual([]);
    expect(source).not.toContain("zod");
  });
});
