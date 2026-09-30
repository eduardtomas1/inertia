import { describe, expect, it } from "vitest";

import { paletteCurrentProjectId } from "../../src/renderer/src/components/AppLayout";
import type { AppSnapshot } from "../../src/shared/contracts";

const scoped = "11111111-1111-4111-8111-111111111111";
const active = "22222222-2222-4222-8222-222222222222";

function snapshot(projectIds: string[], activeProjectId: string | null): AppSnapshot {
  return {
    projects: projectIds.map((id) => ({ id })),
    activeProjectId,
  } as unknown as AppSnapshot;
}

describe("command palette current project", () => {
  it("uses the sidebar project scope while that project exists", () => {
    expect(paletteCurrentProjectId(snapshot([scoped, active], active), scoped)).toBe(scoped);
  });

  it("falls back to the active project when the scoped project was removed", () => {
    expect(paletteCurrentProjectId(snapshot([active], active), scoped)).toBe(active);
  });

  it("uses the active project without a scope and nothing without a snapshot", () => {
    expect(paletteCurrentProjectId(snapshot([active], active), null)).toBe(active);
    expect(paletteCurrentProjectId(null, scoped)).toBeNull();
  });
});
