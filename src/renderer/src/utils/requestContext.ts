import type {
  ChatAttachment,
  TurnRequestContext,
} from "@shared/contracts";

export function promptContextDetail(context: string): string {
  if (context.startsWith("Local review note for ")) {
    return context.split("\n")[0]
      ?.replace(/^Local review note for /u, "")
      .replace(/:$/u, "") ?? "";
  }
  const target = /^Target file:\s*(.+)$/mu.exec(context)?.[1]?.trim();
  return target ? `in ${target}` : context.split("\n")[0] ?? "";
}

export function turnRequestContextFromPromptContext(
  promptContext: string | null | undefined,
): TurnRequestContext | undefined {
  if (!promptContext) return undefined;
  const [firstLine = "", ...bodyLines] = promptContext.split("\n");
  if (firstLine.startsWith("Local review note for ") && firstLine.endsWith(":")) {
    let target = firstLine.slice("Local review note for ".length, -1);
    const stale = target.endsWith(" [stale target]");
    if (stale) target = target.slice(0, -" [stale target]".length);
    const hunkMatch = / \(([^()]*)\)$/u.exec(target);
    const path = hunkMatch ? target.slice(0, hunkMatch.index) : target;
    const body = bodyLines.join("\n").trim();
    if (!path || !body) return undefined;
    return {
      reviewNotes: [{
        path,
        ...(hunkMatch?.[1] ? { hunkId: hunkMatch[1] } : {}),
        body,
        stale,
      }],
    };
  }
  const path = /^Target file:\s*(.+)$/mu.exec(promptContext)?.[1]?.trim();
  const hunkHeader = /^Target hunk:\s*(.+)$/mu.exec(promptContext)?.[1]?.trim();
  const selectedLineCount = Number.parseInt(
    /^Selected lines:\s*(\d+)$/mu.exec(promptContext)?.[1] ?? "",
    10,
  );
  if (!path || !hunkHeader || !Number.isSafeInteger(selectedLineCount) || selectedLineCount < 1) {
    return undefined;
  }
  return {
    diffSelections: [{
      path,
      hunkHeader,
      content: promptContext,
      selectedLineCount,
      truncated: promptContext.includes("[Selection excerpt truncated:"),
    }],
  };
}

export function buildComposerTurnRequest(
  message: string,
  attachments: readonly ChatAttachment[],
  promptContext: string | null | undefined,
  fileReferences: readonly string[] = [],
  previewUrl?: string | null,
  conversationContextPacketIds: readonly string[] = [],
): { visibleContent: string; context?: TurnRequestContext } {
  const visibleContent = message.trim()
    || (attachments.length > 0
      ? "Please inspect the attached file."
      : previewUrl
        ? "Please inspect the current preview."
        : conversationContextPacketIds.length > 0
          ? "Please use the selected chat context."
        : "Please review the selected diff context.");
  const promptRequestContext = turnRequestContextFromPromptContext(promptContext);
  const selectedFileReferences = fileReferences.filter((path) =>
    visibleContent.includes(`@${path}`));
  const context: TurnRequestContext | undefined = promptRequestContext
    || selectedFileReferences.length > 0
    || previewUrl
    || conversationContextPacketIds.length > 0
    ? {
        ...promptRequestContext,
        ...(selectedFileReferences.length > 0
          ? { fileReferences: selectedFileReferences.map((path) => ({ path })) }
          : {}),
        ...(previewUrl ? { previewContexts: [{ url: previewUrl }] } : {}),
        ...(conversationContextPacketIds.length > 0
          ? { conversationContextPacketIds: [...conversationContextPacketIds] }
          : {}),
      }
    : undefined;
  return { visibleContent, ...(context ? { context } : {}) };
}
