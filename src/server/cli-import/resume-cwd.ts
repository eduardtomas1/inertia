import { realpathSync } from "node:fs";
import { relative } from "node:path";
import type { RuntimeStore } from "../database";

export function importedResumeCwd(store: Pick<RuntimeStore, "cliConversationImport" | "conversationPath">, conversationId: string): string {
  const checkout = store.conversationPath(conversationId);
  const imported = store.cliConversationImport(conversationId);
  if (imported?.providerId !== "claude" || imported.cwd === checkout) return checkout;
  try {
    return relative(realpathSync(checkout), realpathSync(imported.cwd)) === "" ? imported.cwd : checkout;
  } catch {
    return checkout;
  }
}
