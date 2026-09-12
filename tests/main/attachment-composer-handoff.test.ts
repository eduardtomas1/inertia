import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { AttachmentRegistry } from "../../src/main/attachment-registry";
import { mergeComposerAttachments } from "../../src/renderer/src/utils/composerAttachments";
import { documentAttachmentContexts } from "../../src/server/runtime/attachments/document-attachment-context";
import { assembleTurnRequest } from "../../src/server/runtime/turns/request-context";

it("preserves equally named native reports through composer adoption and provider prompt assembly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inertia-report-handoff-"));
  const registry = new AttachmentRegistry(directory);
  try {
    const contents = ["Profit: +100", "Profit: -100"] as const;
    const imported = await registry.import([
      ...contents, contents[0],
    ].map((content) => ({ name: "report.txt", mimeType: "text/plain", data: Buffer.from(content) })));
    // Native digest validation still removes truly identical content.
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map(({ id }) => id)).size).toBe(2);
    expect(imported.map(({ name, size, mimeType }) => ({ name, size, mimeType })))
      .toEqual(Array(2).fill({ name: "report.txt", size: 12, mimeType: "text/plain" }));
    const { attachments, rejected } = mergeComposerAttachments([imported[0]!], imported.slice(1));
    expect(rejected).toEqual([]);
    const handoffId = "21212121-2121-4121-8121-212121212121";
    await registry.prepareHandoff(handoffId, attachments.map(({ id }) => id), () => false);
    const documents = await Promise.all(attachments.map(async (attachment) => {
      const trusted = await registry.resolveForRuntime(attachment.id, handoffId);
      expect(trusted).not.toBeNull();
      return { attachment, bytes: await readFile(trusted!.path) };
    }));
    expect(documents.map(({ bytes }) => bytes.toString())).toEqual(contents);
    const documentContexts = await documentAttachmentContexts(documents);
    const assembled = assembleTurnRequest({
      cwd: directory, visibleContent: "Compare both reports.", attachments, documentContexts,
    });
    for (const content of contents) expect(assembled.executionPrompt).toContain(content);
    expect(assembled.persistence.manifest.contextReferenceCount).toBe(2);
  } finally {
    await registry.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
