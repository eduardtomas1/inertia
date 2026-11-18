import { realpathSync } from "node:fs";
import { relative } from "node:path";
import type { RuntimeStore } from "../database";
import type { CliConversationImportRecord } from "../persistence/cli-conversation-import";

type ImportStore = Pick<RuntimeStore, "cliConversationImport">;

export function importedSession(store: ImportStore, conversationId: string, sessionId: string | null | undefined): CliConversationImportRecord | null {
  const imported = store.cliConversationImport(conversationId);
  return imported && sessionId && imported.sessionId === sessionId ? imported : null;
}

export function importedFollowUpNote(imported: CliConversationImportRecord | null, resumesImportedSession: boolean): string | null {
  if (!imported) return null;
  if (imported.continuation === "context") return "Continues in a new session with the imported messages as earlier context";
  if (!resumesImportedSession) return null;
  return imported.providerId === "codex"
    ? "This chat continues a Codex CLI session, so Inertia's Browser and other host tools are not available in it."
    : "Continues the original Claude Code session";
}

/** Whether two folders are the same checkout, comparing canonical paths; a missing folder matches nothing. */
export function sameCheckoutPath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    // The native form returns the folder's on-disk spelling, so case differences on macOS compare equal.
    return relative(realpathSync.native(right), realpathSync.native(left)) === "";
  } catch {
    return false;
  }
}

export function importedResumeCwd(store: ImportStore, conversationId: string, sessionId: string | null | undefined, checkout: string): string {
  const imported = importedSession(store, conversationId, sessionId);
  if (imported?.providerId !== "claude" || imported.cwd === checkout) return checkout;
  return sameCheckoutPath(imported.cwd, checkout) ? imported.cwd : checkout;
}
