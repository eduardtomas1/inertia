import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { objectValue, type JsonObject } from "../codex/protocol";
import { AcpSecretRedactor } from "./acp-redaction";
import { controlNativeConversation } from "./native-conversation-control";
import { nativeId, NativeConversationRejection, retainedNativeHead, type NativeConversationOperations } from "./native-conversation-operations";
import { piLaunchConfiguration, piRpcArguments, type PiLaunchConfiguration } from "./pi-launch";
import { openPiRpcConnection, type PiRpcConnection, type PiRpcOptions } from "./pi-rpc";
import { ensurePiSessionDirectory, findPiSessionFile, listPiSessionFiles, locatePiSessionFile, piSessionInCheckout, piSessionState,
  readPiSessionEntryIds, removeUnannouncedPiSession } from "./pi-session";

export function piActiveEntries(value: unknown): { entries: JsonObject[]; leafId: string | null } {
  const record = objectValue(value);
  if (!record || !Array.isArray(record.entries) || record.entries.length > 20_000
    || (record.leafId !== null && !nativeId(record.leafId))) throw new Error("Invalid Pi session tree.");
  const entries = new Map<string, JsonObject>();
  for (const raw of record.entries) {
    const entry = objectValue(raw);
    if (!entry || !nativeId(entry.id) || entries.has(entry.id) || (entry.parentId !== null && !nativeId(entry.parentId))) throw new Error("Invalid Pi entry identity.");
    entries.set(entry.id, entry);
  }
  const branch: JsonObject[] = []; const seen = new Set<string>();
  let cursor = record.leafId as string | null;
  while (cursor !== null) {
    const entry = entries.get(cursor);
    if (!entry || seen.has(cursor)) throw new Error("Pi active branch is incomplete or cyclic.");
    seen.add(cursor); branch.push(entry); cursor = entry.parentId as string | null;
  }
  return { entries: branch.reverse(), leafId: record.leafId as string | null };
}

/** The fork process could not be confirmed stopped; `child` is its process for the caller's cleanup proof. */
export class PiForkCleanupError extends Error {
  constructor(readonly child: PiRpcConnection["child"]) { super("Pi fork cleanup is unconfirmed."); }
}

/**
 * Pi definitely did not copy the session here: it answered with the original or with a session that already
 * existed, or with an empty or foreign history. Retrying cannot help. Everything else (transport failures, timeouts,
 * unsafe identities, an original Inertia cannot read, a copy that grew or names another file or checkout) is an
 * ordinary failure that keeps the session.
 */
export class PiForkRefusedError extends Error {}

/** Entries Pi appends when it opens a session that lacks them (sdk.js "Restore missing settings metadata"). */
const PI_SETTINGS_METADATA = new Set(["thinking_level_change", "model_change"]);

/**
 * Whether Pi's copy holds the original's history. `pi --fork` copies every entry with its id (`forkFrom`); opening
 * the copy may append settings metadata, which then is the head. A copy that does not start with the original's
 * entries is empty or foreign (definite); one that holds more than the original plus settings metadata (the
 * original grew meanwhile) is an ordinary failure.
 */
export function piForkCopyHolds(sourceIds: readonly string[], copied: readonly (JsonObject | undefined)[], leafId: string | null): void {
  const ids = copied.map((entry) => entry?.id);
  if (ids.length < sourceIds.length || sourceIds.some((id, index) => ids[index] !== id)) {
    throw new PiForkRefusedError("Pi's copy does not hold the original session's history.");
  }
  if (copied.slice(sourceIds.length).some((entry) => !PI_SETTINGS_METADATA.has(String(entry?.type)))) {
    throw new Error("Pi's copy holds entries the original did not have when it was read.");
  }
  if (leafId !== (ids.at(-1) ?? null)) throw new Error("Pi's copy has an unexpected head.");
}

/**
 * Copies a session into `cwd` with a short-lived `pi --fork` (no tools, extensions or context files) and returns
 * the new session. Pi records the launch folder as the fork's cwd; resuming the original file would keep the
 * checkout it was created in (T3 `forkSessionIntoCwd`, bebaf3ec0). Inertia only reads the source file (Pi itself
 * completes a torn last line when it loads one). The copy must be a session file that did not exist before, whose
 * header names `cwd`, and that holds the original's entries (`piForkCopyHolds`). A copy Pi created but that is
 * refused is removed when its process is confirmed stopped.
 */
export async function forkPiSessionIntoCheckout(input: {
  config: PiLaunchConfiguration; environment: NodeJS.ProcessEnv; root: string; sourceId: string; sourceFile: string;
  cwd: string; signal: AbortSignal; redact: AcpSecretRedactor;
  dependencies?: Pick<PiRpcOptions, "spawnProcess" | "terminateProcessTree">;
}): Promise<{ id: string; file: string }> {
  // An original Inertia cannot read within its limits is an ordinary failure: Pi itself may still resume it in place.
  const sourceEntries = await readPiSessionEntryIds(input.sourceFile, input.root, input.signal);
  const existing = await listPiSessionFiles(input.root, input.signal);
  const target = openPiRpcConnection({ executable: input.config.executable, environment: input.environment, cwd: input.cwd,
    args: piRpcArguments({ ...input.config, args: [] }, { forkFile: input.sourceFile }), signal: input.signal,
    ...input.dependencies });
  let forked: { id: string; file: string } | undefined;
  let created: { id: string; file: string } | undefined;
  let failure: unknown;
  try {
    const state = piSessionState(await target.request("get_state"), input.root);
    const name = basename(state.file);
    if (state.id === input.sourceId || state.file === input.sourceFile || existing.has(name)
      || [...existing].some((entry) => entry.endsWith(`_${state.id}.jsonl`))) {
      throw new PiForkRefusedError("Pi did not create a new session for the copy.");
    }
    created = { id: state.id, file: state.file };
    if (input.redact.payload(state.id) !== state.id) throw new Error("Pi returned an unsafe native identity.");
    if (state.streaming || state.compacting || state.pending) throw new Error("Pi fork is not idle.");
    const record = objectValue(await target.request("get_entries"));
    piActiveEntries(record);
    const copied = Array.isArray(record?.entries) ? record.entries.map((entry) => objectValue(entry)) : [];
    piForkCopyHolds(sourceEntries, copied, (record?.leafId ?? null) as string | null);
    const head = record?.leafId as string | null;
    if (head !== null && input.redact.payload(head) !== head) throw new Error("Pi returned an unsafe native anchor.");
    const located = await locatePiSessionFile(input.root, state.id, input.signal);
    if (located.file !== state.file) throw new Error("Pi's copy is not the file it reported.");
    if (!await piSessionInCheckout(located.cwd, input.cwd)) throw new Error("Pi's copy names another checkout.");
    forked = created;
  } catch (error) { failure = error; }
  try { await target.close(); } catch { throw new PiForkCleanupError(target.child); }
  if (!forked) {
    if (created) await removeUnannouncedPiSession(input.root, created.id, created.file);
    throw failure;
  }
  return forked;
}

export function createPiNativeConversationOperations(active: ReadonlySet<string>,
  dependencies: Pick<PiRpcOptions, "spawnProcess" | "terminateProcessTree"> = {}): NativeConversationOperations {
  return { capabilities: { fork: "native", rollback: "native-fork" },
    execute: (request, launch) => controlNativeConversation(request, launch, active, true, async (signal, progress) => {
      if (request.source.nativeSessionId !== undefined && request.source.nativeSessionId !== request.source.nativeConversationId) {
        throw new NativeConversationRejection("rejected", "native-session-mismatch");
      }
      const config = piLaunchConfiguration(launch.environment, launch.executable);
      const redact = new AcpSecretRedactor(launch.environment);
      const root = await ensurePiSessionDirectory(config.sessionDirectory, signal);
      const sourceCwd = launch.sourceCwd ?? launch.cwd;
      if (await realpath(sourceCwd) !== resolve(sourceCwd)) throw new NativeConversationRejection("rejected", "source-workspace-not-canonical");
      const sourceFile = await findPiSessionFile(root, request.source.nativeConversationId, sourceCwd, signal);
      const retained = retainedNativeHead(request.boundary);
      const lease = launch.installationUse?.accept();
      if (launch.installationUse && !lease) throw new NativeConversationRejection("rejected", "installation-authority-consumed");
      let cleanupConfirmed = true;
      const open = (cwd: string, args: string[]) => {
        try { return openPiRpcConnection({ executable: config.executable, environment: launch.environment,
          cwd, args, signal, timeoutMs: launch.timeoutMs, ...dependencies }); }
        catch (error) { cleanupConfirmed = false; throw error; }
      };
      const close = async (connection: ReturnType<typeof open>): Promise<void> => {
        try { await connection.close(); } catch (error) { cleanupConfirmed = false; throw error; }
      };
      const quiet = { ...config, args: [] };
      try {
        const source = open(sourceCwd, piRpcArguments(quiet, { sessionFile: sourceFile }));
        let tree: ReturnType<typeof piActiveEntries>;
        try {
          const state = piSessionState(await source.request("get_state"), root, request.source.nativeConversationId);
          if (state.streaming || state.compacting || state.pending) throw new NativeConversationRejection("rejected", "conversation-busy");
          tree = piActiveEntries(await source.request("get_entries"));
          if (tree.leafId !== request.source.expectedHeadId) throw new NativeConversationRejection("rejected", "native-head-changed");
          if (retained !== null && !tree.entries.some((entry) => entry.id === retained)) throw new NativeConversationRejection("rejected", "boundary-not-on-active-branch");
        } finally { await close(source); }
        signal.throwIfAborted();
        if (request.kind === "rollback" && retained === tree.leafId) {
          return { status: "completed", effect: "unchanged", backing: { nativeConversationId: request.source.nativeConversationId, headId: retained, persistedHeadId: retained } };
        }
        if (retained === null) {
          const id = randomUUID();
          return { status: "completed", effect: "new-session", backing: { nativeConversationId: id, headId: null, persistedHeadId: null,
            continuation: { kind: "new-session", nativeConversationId: id } } };
        }
        const retainedIndex = tree.entries.findIndex((entry) => entry.id === retained);
        const discarded = tree.entries.slice(retainedIndex + 1);
        const forkAt = discarded.find((entry) => entry.type === "message" && objectValue(entry.message)?.role === "user");
        // Native fork excludes a user entry. Never silently retain discarded assistant/tool work.
        if (discarded.some((entry) => entry.type === "message") && discarded.find((entry) => entry.type === "message") !== forkAt) {
          throw new NativeConversationRejection("unsupported", "boundary-is-not-a-complete-native-turn");
        }
        progress.mutationMayHaveOccurred = true;
        const target = open(launch.cwd, piRpcArguments(quiet, { forkFile: sourceFile }));
        try {
          let state = piSessionState(await target.request("get_state"), root);
          if (state.id === request.source.nativeConversationId) throw new Error("Pi did not create a distinct fork.");
          if (redact.payload(state.id) !== state.id) throw new Error("Pi returned an unsafe native identity.");
          progress.createdNativeConversationId = state.id;
          const cloned = piActiveEntries(await target.request("get_entries"));
          if (cloned.leafId !== tree.leafId || JSON.stringify(cloned.entries) !== JSON.stringify(tree.entries)) {
            throw new Error("Pi source history changed while creating the fork.");
          }
          if (forkAt) {
            const result = objectValue(await target.request("fork", { entryId: forkAt.id }));
            if (result?.cancelled !== false) throw new Error("Pi fork was not confirmed.");
            state = piSessionState(await target.request("get_state"), root);
            if (state.id === request.source.nativeConversationId) throw new Error("Pi fork reverted to its source.");
            if (redact.payload(state.id) !== state.id) throw new Error("Pi returned an unsafe native identity.");
            progress.createdNativeConversationId = state.id;
          }
          const branch = piActiveEntries(await target.request("get_entries"));
          if (branch.leafId !== null && redact.payload(branch.leafId) !== branch.leafId) throw new Error("Pi returned an unsafe native anchor.");
          const expectedMessages = tree.entries.slice(0, retainedIndex + 1).filter((entry) => entry.type === "message");
          const retainedMessages = branch.entries.filter((entry) => entry.type === "message");
          if (!branch.entries.some((entry) => entry.id === retained)
            || JSON.stringify(retainedMessages) !== JSON.stringify(expectedMessages)) throw new Error("Pi did not preserve the requested inclusive boundary.");
          await findPiSessionFile(root, state.id, launch.cwd, signal);
          return { status: "completed", effect: "native-fork", backing: { nativeConversationId: state.id,
            headId: branch.leafId, persistedHeadId: branch.leafId } };
        } finally { await close(target); }
      } finally {
        if (cleanupConfirmed) lease?.release({ cleanupConfirmed: true }); else lease?.quarantine("pi-native-cleanup-unconfirmed");
      }
    }),
  };
}
