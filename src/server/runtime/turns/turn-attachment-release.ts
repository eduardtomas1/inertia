import type { ActiveTurn, TurnControllerHooks } from "./turn-controller-types";

export async function releaseTurnAttachments(active: ActiveTurn, hooks: TurnControllerHooks): Promise<void> {
  if (active.attachmentsReleased || (active.attachmentIds.length === 0 && active.generatedAttachmentPaths.length === 0)) return;
  if (active.attachmentRelease) return await active.attachmentRelease;
  const release = Promise.all([
    active.attachmentIds.length > 0
      ? Promise.resolve(hooks.releaseTurnAttachments?.({ turn: active.turn, attachmentIds: active.attachmentIds }))
      : Promise.resolve(),
    active.generatedAttachmentPaths.length > 0
      ? Promise.resolve(hooks.releaseGeneratedAttachments?.(active.generatedAttachmentPaths)
        ?? Promise.reject(new Error("Generated attachment cleanup is unavailable.")))
      : Promise.resolve(),
  ]).then(() => { active.attachmentsReleased = true; });
  active.attachmentRelease = release;
  try { await release; } finally { if (active.attachmentRelease === release) active.attachmentRelease = null; }
}
