import { describe, expect, it } from "vitest";

import { parseAttachments, parseStoredAttachments } from "../../src/server/persistence/codecs";

describe("stored attachment codec", () => {
  const image = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "reference.png",
    path: "/private/reference.png",
    mimeType: "image/png",
    size: 8,
  };
  const yaml = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "config.yaml",
    path: "/private/config.yaml",
    mimeType: "text/plain",
    size: 12,
  };

  it("reads plain-text attachment names through the live codec while the frozen parser stays unchanged", () => {
    const stored = JSON.stringify([
      image,
      yaml,
      { ...yaml, id: "33333333-3333-4333-8333-333333333333", mimeType: "application/json" },
      { ...yaml, id: "44444444-4444-4444-8444-444444444444", name: "secrets.env" },
      { ...image, id: "55555555-5555-4555-8555-555555555555", snapshot: { kind: "unknown" } },
    ]);
    expect(parseStoredAttachments(stored)).toEqual([
      image,
      yaml,
      { ...image, id: "55555555-5555-4555-8555-555555555555" },
    ]);
    // Migration 56 replays with the frozen name lookup, which predates the plain-text set.
    expect(parseAttachments(stored)).toEqual([
      image,
      { ...image, id: "55555555-5555-4555-8555-555555555555" },
    ]);
  });

  it("keeps the frozen parser's bounds and rejects malformed rows", () => {
    expect(parseStoredAttachments("not-json")).toEqual([]);
    expect(parseStoredAttachments(JSON.stringify([
      null,
      { ...image, mimeType: "application/zip" },
      { ...image, size: 0 },
      { ...image, name: "../reference.png" },
      { ...image, id: "not-a-uuid" },
    ]))).toEqual([]);
    const bounded = Array.from({ length: 9 }, (_, index) => ({
      ...image,
      id: `0000000${index}-0000-4000-8000-00000000000${index}`,
      size: 3 * 1024 * 1024,
    }));
    expect(parseStoredAttachments(JSON.stringify([bounded[0], bounded[0], ...bounded.slice(1)])))
      .toEqual(bounded.slice(0, 6));
    expect(parseStoredAttachments(JSON.stringify(bounded.map((attachment) => ({ ...attachment, size: 1 })))))
      .toHaveLength(8);
  });

  it("carries a valid snapshot source and drops an invalid one", () => {
    const snapshot = {
      appName: "Inertia",
      windowTitle: "Workspace",
      capturedAt: "2026-09-24T07:00:00.000Z",
      width: 640,
      height: 480,
      accessibility: {
        format: "element-tree",
        coordinateSpace: "captured-image",
        truncated: false,
        nodes: [],
      },
    };
    expect(parseStoredAttachments(JSON.stringify([{ ...image, snapshot }])))
      .toEqual([{ ...image, snapshot }]);
    expect(parseStoredAttachments(JSON.stringify([{ ...image, snapshot: { kind: 7 } }])))
      .toEqual([image]);
  });
});
