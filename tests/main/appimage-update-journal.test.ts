import { describe, expect, it } from "vitest";

import {
  createAppImageHandoffJournal,
  parseAppImageUpdateJournal,
} from "../../src/main/appimage-update-journal";

function journal() {
  return createAppImageHandoffJournal({
    channel: "stable",
    phase: "staged",
    operationId: "11111111-1111-4111-8111-111111111111",
    originalName: "Inertia-0.0.47.AppImage",
    stableName: "Inertia.AppImage",
    original: { dev: "1", ino: "2" },
    candidate: { dev: "3", ino: "4" },
    candidateArtifactDigest: "a".repeat(64),
    candidateExecutableIdentityDigest: "b".repeat(64),
  });
}

describe("AppImage update journal format", () => {
  it("uses a stable cross-platform checksum vector", () => {
    expect(journal().checksum).toBe(
      "6b2aeecc8ae642072e5468d32592884dd829959f51f1e836230031627cd754aa",
    );
  });

  it("validates reordered JSON through the canonical payload", () => {
    const value = journal();
    const reordered = {
      checksum: value.checksum,
      stableName: value.stableName,
      originalName: value.originalName,
      candidate: value.candidate,
      original: value.original,
      candidateExecutableIdentityDigest:
        value.candidateExecutableIdentityDigest,
      candidateArtifactDigest: value.candidateArtifactDigest,
      operationId: value.operationId,
      phase: value.phase,
      channel: value.channel,
      schema: value.schema,
    };

    expect(parseAppImageUpdateJournal(
      reordered,
      "stable",
      "Inertia.AppImage",
    )).toEqual(value);
  });

  it("fails closed on tampering and unknown keys", () => {
    const value = journal();
    expect(() => parseAppImageUpdateJournal({
      ...value,
      candidateArtifactDigest: "c".repeat(64),
    }, "stable", "Inertia.AppImage")).toThrow(
      "AppImage update recovery journal is invalid",
    );
    expect(() => parseAppImageUpdateJournal({
      ...value,
      providerPayload: "must-not-be-accepted",
    }, "stable", "Inertia.AppImage")).toThrow(
      "AppImage update recovery journal is invalid",
    );
  });
});
