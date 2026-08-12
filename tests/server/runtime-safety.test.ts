import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RUNTIME_COMMAND_TYPES } from "../../src/server/runtime/commands/command-router";
import {
  RUNTIME_SAFETY_READ_COMMAND_TYPES,
  runtimeSafetyAllowsCommand,
} from "../../src/server/runtime/commands/runtime-safety";
import { startTestRuntime } from "../support/test-runtime";

describe("runtime recovery safety command boundary", () => {
  it("defaults every command except exact conversation detail reads to denied", () => {
    const allowed = RUNTIME_COMMAND_TYPES.filter(runtimeSafetyAllowsCommand);
    expect(allowed).toEqual([...RUNTIME_SAFETY_READ_COMMAND_TYPES]);
    expect(RUNTIME_COMMAND_TYPES).toHaveLength(
      RUNTIME_COMMAND_TYPES.filter((type) => !runtimeSafetyAllowsCommand(type))
        .length + RUNTIME_SAFETY_READ_COMMAND_TYPES.length,
    );
  });

  it("preserves durable attachments while prior-runtime cleanup is unconfirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    const attachmentId = randomUUID();
    const attachmentStore = await ConversationAttachmentStore.open(dataDirectory);
    await attachmentStore.retain([{
      attachment: {
        id: attachmentId,
        name: "preserved.png",
        path: attachmentId,
        mimeType: "image/png",
        size: 8,
      },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }]);
    const reconcile = vi.spyOn(
      ConversationAttachmentStore.prototype,
      "reconcile",
    );
    try {
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        priorRuntimeCleanupUnconfirmed: true,
        runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
      });
      try {
        expect(reconcile).not.toHaveBeenCalled();
        await expect(attachmentStore.preview(attachmentId)).resolves
          .toMatchObject({
            attachment: { id: attachmentId },
            bytes: Buffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]),
          });
      } finally {
        await runtime.close();
      }
    } finally {
      reconcile.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
