import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { attachmentCleanupAuthority } from "../../src/server/runtime/attachments/attachment-cleanup-authority";
import { TurnAdmissionCoordinator } from "../../src/server/runtime/turns/turn-admission-coordinator";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function attachment(id: string): Record<string, unknown> {
  return { id, name: "reference.png", path: id, mimeType: "image/png", size: 8 };
}

it("blocks turn admission in every chat owning a cleanup candidate and keeps files shared with chats it cannot lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inertia-attachment-cleanup-authority-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
  const admissions = new TurnAdmissionCoordinator({
    isClosing: () => false,
    isActive: () => false,
    hasProviderCleanup: () => false,
    waitForProviderCleanup: async () => true,
    blocksForGoalMutation: () => false,
    waitForGoalIdle: async () => true,
  });
  try {
    const projectId = store.createProject("Cleanup", directory).id;
    const finished = store.createConversation(projectId, "Finished");
    const sending = store.createConversation(projectId, "Sending");
    const [own, shared, sendingOnly] = [randomUUID(), randomUUID(), randomUUID()];
    const at = (second: number): string => new Date(Date.UTC(2026, 8, 26, 8, 0, second)).toISOString();
    store.createMessage(finished.id, "Old", "user", [attachment(own), attachment(shared)] as never, null, at(0));
    store.createMessage(sending.id, "Old", "user", [attachment(shared), attachment(sendingOnly)] as never, null, at(1));
    expect(store.evictableAttachmentIds()).toEqual([own, shared, sendingOnly]);
    const messageSend = await admissions.acquire(sending.id, 100);
    expect(messageSend).not.toBeNull();

    const authority = await attachmentCleanupAuthority(store, {
      acquireTurnAdmission: async (conversationId, timeoutMs) => await admissions.acquire(conversationId, timeoutMs),
    })([own, shared, sendingOnly]);

    expect(authority.order()).toEqual([own]);
    expect(() => admissions.assertQueueAuthority(finished.id)).toThrow("Another message is being prepared");
    await expect(admissions.acquire(finished.id, 50)).resolves.toBeNull();
    authority.release();
    messageSend!.release();
    await expect(admissions.acquire(finished.id, 50)).resolves.not.toBeNull();
  } finally {
    admissions.dispose();
    store.close();
  }
});
