import type {
  ProviderHostToolBridge,
  ProviderHostToolDefinition,
} from "../provider/contracts";
import {
  harnessCapabilityPacksOf,
  harnessCapabilityThreadRegistrationsOf,
} from "../runtime/harness-capabilities";
import {
  CachedThreadToolRegistrations,
  type ThreadToolRegistrations,
} from "../runtime/thread-tool-registrations";
import type { HiddenProviderInstruction } from "../runtime/turns/request-context";

/**
 * Registrations of threads whose bridge carries no durable record: a thread
 * started without host tools, or by a bridge a capability registry did not
 * build. They last for this runtime only.
 */
const unscopedRegistrations = new CachedThreadToolRegistrations();

function registrationsOf(bridge: ProviderHostToolBridge | undefined): ThreadToolRegistrations {
  return (bridge && harnessCapabilityThreadRegistrationsOf(bridge)) ?? unscopedRegistrations;
}

/**
 * The dynamic tools a new Codex thread registers: every capability pack,
 * offered or withheld, so that turning a project setting back on later does not
 * leave the thread without tools its instructions describe. A withheld pack's
 * calls answer its withholding reason.
 */
export function codexThreadStartTools(
  bridge: ProviderHostToolBridge,
): readonly ProviderHostToolDefinition[] {
  const packs = harnessCapabilityPacksOf(bridge);
  return packs ? packs.flatMap(({ definitions }) => definitions) : bridge.definitions;
}

/**
 * Records the packs a new thread registered at `thread/start`, by pack id and
 * definition digest. Codex keeps those dynamic tools for the thread's lifetime
 * and accepts no registration on `thread/resume`. A bridge from a capability
 * registry with a durable store keeps the record across runtime restarts; a
 * thread without a bridge registered no packs.
 */
export function recordCodexThreadRegistration(
  threadId: string,
  bridge: ProviderHostToolBridge | undefined,
): void {
  const packs = bridge ? harnessCapabilityPacksOf(bridge) ?? [] : [];
  registrationsOf(bridge).record(threadId, new Map(packs.map(({ id, digest }) => [id, digest])));
}

/**
 * The offered instructions a resumed thread must not receive: a pack's
 * instructions stay only when the thread registered that exact pack. A thread
 * without a recorded registration keeps only packs every resumable thread
 * registered, so it keeps the Browser instructions and the `inertia-chat` line.
 * The caller removes them from both the session's `developerInstructions` and
 * the prompt.
 */
export function codexResumedThreadWithheldInstructions(
  threadId: string,
  bridge: ProviderHostToolBridge | undefined,
): readonly HiddenProviderInstruction[] {
  const packs = bridge ? harnessCapabilityPacksOf(bridge) : undefined;
  if (!packs) return [];
  const registered = registrationsOf(bridge).read(threadId) ?? unscopedRegistrations.read(threadId);
  return packs
    .filter((pack) => pack.offered && pack.instructions.length > 0)
    .filter((pack) => registered
      ? registered.get(pack.id) !== pack.digest
      : !pack.registeredOnEveryResumableThread)
    .flatMap(({ instructions }) => instructions);
}
