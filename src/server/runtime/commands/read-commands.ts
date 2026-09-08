import { createUsageCommandHandler, type UsageCommandDependencies } from "./usage-commands";
import { createMessageSearchCommandHandler, MessageSearchController } from "./message-search-commands";
import type { MessageSearchTarget } from "../../../shared/message-search";
import type { RuntimeCommandHandler } from "./command-router";

export function createReadCommandHandlers(input: UsageCommandDependencies & {
  databasePath: string;
  lifetimeSignal: AbortSignal;
  reveal(target: MessageSearchTarget): void;
}): RuntimeCommandHandler[] {
  const searches = new MessageSearchController(input.databasePath);
  // Every search remains in the runtime's tracked-command drain until its
  // worker exits. Abort before that drain so shutdown never waits for a scan.
  input.lifetimeSignal.addEventListener("abort", () => { void searches.close(); }, { once: true });
  return [createUsageCommandHandler(input), createMessageSearchCommandHandler({ ...input, searches })];
}
