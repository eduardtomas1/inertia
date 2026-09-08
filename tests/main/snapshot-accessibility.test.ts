import { describe, expect, it } from "vitest";
import { readSnapshotAccessibility, type SnapshotElement } from "../../src/main/snapshot-accessibility";
import { SNAPSHOT_MAX_NODES, SNAPSHOT_MAX_TEXT, snapshotPlatformAvailable, snapshotSourceSchema } from "../../src/shared/snapshots";
import { snapshotFixture } from "../helpers/snapshot-fixture";

function node(input: Partial<SnapshotElement> = {}, children: SnapshotElement[] = []): SnapshotElement {
  return { role: "static_text", name: "Read me", value: null, bounds: null, raw: {}, children: async () => children, ...input };
}

describe("bounded snapshot accessibility", () => {
  it.each([
    { role: "text_field" },
    { raw: { ax_subrole: "AXSecureTextField" } },
    { raw: { atspi_role: "password text" } },
    { name: "API key" },
  ])("redacts protected controls and their descendants: %j", async (properties) => {
    const bounds = { x: -400, y: 40, width: 100, height: 30 };
    const root = node({}, [node({ ...properties, bounds, value: "fixture-protected-value" }, [node({ name: "descendant-protected-value" })])]);
    const result = await readSnapshotAccessibility(root, () => true);
    expect(JSON.stringify(result.nodes)).not.toContain("protected-value");
    expect(result.nodes[1]).toMatchObject({ redacted: true, bounds });
    expect(result.redactions).toEqual([bounds]);
    expect(result.complete).toBe(true);
  });

  it("refuses a protected field whose image position is unknown", async () => {
    await expect(readSnapshotAccessibility(node({ role: "text_field", value: "secret" }), () => true)).rejects.toThrow("could not be located safely");
  });

  it("bounds output while continuing the protected-field scan", async () => {
    const children = Array.from({ length: SNAPSHOT_MAX_NODES + 20 }, () => node({ name: "a".repeat(1000), value: "b".repeat(2000) }));
    children.push(node({ role: "text_field", value: "never-output", bounds: { x: 1, y: 2, width: 3, height: 4 } }));
    const result = await readSnapshotAccessibility(node({}, children), () => true);
    expect(result.nodes.length).toBeLessThanOrEqual(SNAPSHOT_MAX_NODES);
    expect(result.nodes.reduce((sum, item) => sum + (item.name?.length ?? 0) + (item.value?.length ?? 0), 0)).toBeLessThanOrEqual(SNAPSHOT_MAX_TEXT);
    expect(result.redactions).toHaveLength(1);
    expect(result).toMatchObject({ complete: true, truncated: true });
  });

  it("reports an incomplete scan on timeout or excessive depth", async () => {
    expect(await readSnapshotAccessibility(node(), () => false)).toMatchObject({ complete: false });
    let nested = node();
    for (let depth = 0; depth < 18; depth++) nested = node({}, [nested]);
    expect(await readSnapshotAccessibility(nested, () => true)).toMatchObject({ complete: false });
  });

  it("never copies raw platform dictionaries or control characters", async () => {
    const result = await readSnapshotAccessibility(node({ name: "safe\0name", raw: { hiddenSecret: "unrelated" } }), () => true);
    expect(result.nodes).toEqual([{ depth: 0, role: "static_text", name: "safename" }]);
  });

  it("rejects malformed native payloads and unsupported desktop sessions", () => {
    expect(snapshotSourceSchema.safeParse(snapshotFixture()).success).toBe(true);
    expect(snapshotSourceSchema.safeParse({ ...snapshotFixture(), width: 100_000 }).success).toBe(false);
    expect(snapshotPlatformAvailable("linux", { DISPLAY: ":0" })).toBe(true);
    expect(snapshotPlatformAvailable("linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
    expect(snapshotPlatformAvailable("linux", {})).toBe(false);
    expect(snapshotPlatformAvailable("win32", {})).toBe(true);
    expect(snapshotPlatformAvailable("darwin", {})).toBe(true);
  });
});
