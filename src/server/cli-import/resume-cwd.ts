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

export function importedResumeCwd(store: ImportStore, conversationId: string, sessionId: string | null | undefined, checkout: string): string {
  const imported = importedSession(store, conversationId, sessionId);
  if (imported?.providerId !== "claude" || imported.cwd === checkout) return checkout;
  try {
    return relative(realpathSync(checkout), realpathSync(imported.cwd)) === "" ? imported.cwd : checkout;
  } catch {
    return checkout;
  }
}
