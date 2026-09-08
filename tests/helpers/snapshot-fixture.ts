import type { SnapshotSource } from "../../src/shared/snapshots";

export function snapshotFixture(): SnapshotSource {
  return {
    appName: "Notes", windowTitle: "Release checklist", capturedAt: "2026-09-08T09:00:00.000Z", width: 800, height: 500,
    accessibility: { format: "element-tree", coordinateSpace: "captured-image", truncated: false,
      nodes: [
        { depth: 0, role: "window", name: "Release checklist", bounds: { x: 0, y: 0, width: 800, height: 500 } },
        { depth: 1, role: "static_text", name: "Check keyboard navigation and restore focus after preview." },
        { depth: 1, role: "button", name: "Publish", bounds: { x: 640, y: 420, width: 100, height: 32 } },
        { depth: 1, role: "text_field", redacted: true, bounds: { x: 40, y: 180, width: 320, height: 36 } },
      ],
    },
  };
}
