import { createHash } from "node:crypto";

import {
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeafFromRoot,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalTestHooks,
} from "../node/direct-runtime-journal.js";
import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import {
  parseLegacyWindowsUnobservedProcessRecordLeaf,
  parseRuntimeOwnedProcessContainmentLeaf,
  parseRuntimeOwnedProcessRecordLeaf,
  RuntimeOwnedProcessJournal,
} from "../node/runtime-owned-process-journal.js";
import { runtimeOwnedProcessRetiringWriterName } from
  "../node/runtime-owned-process-session-journal.js";

const MAX_CLAIM_BYTES = 768;
const MAX_CLAIM_LEAVES = 256 * 4;

function unchanged(
  expected: DirectRuntimeJournalLeaf,
  current: DirectRuntimeJournalLeaf | null,
): boolean {
  return !!current
    && current.identity.device === expected.identity.device
    && current.identity.inode === expected.identity.inode
    && current.bytes.equals(expected.bytes);
}

/**
 * Startup-only repair of Windows v1 owned claims written with PID zero.
 * Restore their unobserved intent, never infer that a process stopped. The
 * exact named Job must still be recovered before any claim/session/lease is
 * retired or a replacement runtime is admitted.
 */
export function repairLegacyWindowsUnobservedProcessClaims(
  dataDirectory: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly hooks?: DirectRuntimeJournalTestHooks;
  } = {},
): boolean {
  if ((options.platform ?? process.platform) !== "win32") return true;
  try {
    const root = pinDirectRuntimeJournalRoot(dataDirectory);
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    if (!leases.isValid()) return false;
    const journal = new RuntimeOwnedProcessJournal(dataDirectory, { platform: "win32" });
    const candidates = [];
    for (const name of listDirectRuntimeJournalLeaves(root, ".runtime-owned-child-", MAX_CLAIM_LEAVES)) {
      const match = /^\.runtime-owned-child-([0-9a-f-]{36})\.json$/u.exec(name);
      if (!match) {
        // The existing reader owns settlement of these uncommitted or already
        // consumed leaves. Leave them untouched; normalization grants no
        // cleanup authority and ordinary admission must still validate them.
        if (/^\.runtime-owned-child-[0-9a-f-]{36}\.(begin|claim|retire|consume)\.tmp$/u.test(name)) continue;
        return false;
      }
      const leaf = readDirectRuntimeJournalLeaf(root, name, MAX_CLAIM_BYTES);
      if (!leaf) return false;
      if (parseRuntimeOwnedProcessRecordLeaf(leaf.bytes, match[1]!)) continue;
      const claim = parseLegacyWindowsUnobservedProcessRecordLeaf(leaf.bytes, match[1]!);
      if (!claim) return false;
      const lease = leases.all().find((candidate) =>
        candidate.runtimeGenerationId === claim.runtimeGenerationId);
      const session = journal.sessionExact(claim.runtimeGenerationId);
      if (!lease || !session
        || lease.systemBootId !== claim.systemBootId
        || session.systemBootId !== claim.systemBootId) return false;
      const generationHash = createHash("sha256").update(claim.runtimeGenerationId).digest("hex");
      const containmentName = `.runtime-owned-process-containment-${generationHash}.json`;
      const containmentLeaf = readDirectRuntimeJournalLeaf(root, containmentName, MAX_CLAIM_BYTES);
      const containment = containmentLeaf && parseRuntimeOwnedProcessContainmentLeaf(
        containmentLeaf.bytes, generationHash,
      );
      const jobName = `Global\\InertiaRuntime-${generationHash}`;
      if (!containmentLeaf || !containment
        || containment.runtimeGenerationId !== claim.runtimeGenerationId
        || containment.systemBootId !== claim.systemBootId
        || (JSON.parse(containmentLeaf.bytes.toString("utf8")) as {
          containment: { name: string };
        }).containment.name !== jobName) return false;
      candidates.push({ name, leaf, claim, lease, session, containmentName, containmentLeaf, jobName });
    }
    // Validate the complete batch before fencing or rewriting any generation.
    for (const candidate of candidates) {
      const { claim, session, name, leaf, containmentName, containmentLeaf, jobName } = candidate;
      if (!journal.fenceSessionExact(session)
        || journal.containment(claim.runtimeGenerationId)?.name !== jobName) return false;
      const writer = pinDirectRuntimeJournalChildRoot(
        root, runtimeOwnedProcessRetiringWriterName(claim.runtimeGenerationId),
      );
      if (!writer) return false;
      const pending = Buffer.from(JSON.stringify({
        version: claim.version,
        state: "pending",
        ownershipId: claim.ownershipId,
        runtimeGenerationId: claim.runtimeGenerationId,
        systemBootId: claim.systemBootId,
      }), "utf8");
      if (!writeDirectRuntimeJournalLeafFromRoot(
        writer, `.runtime-owned-child-${claim.ownershipId}.claim.tmp`, root, name, pending,
        {
          ...options.hooks,
          beforeRename: (source, target) => {
            options.hooks?.beforeRename?.(source, target);
            const currentLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
            if (!currentLeases.isValid()
              || !currentLeases.all().some((current) =>
                JSON.stringify(current) === JSON.stringify(candidate.lease))
              || !journal.fenceSessionExact(session)
              || !unchanged(leaf, readDirectRuntimeJournalLeaf(root, name, MAX_CLAIM_BYTES))
              || !unchanged(containmentLeaf, readDirectRuntimeJournalLeaf(
                root, containmentName, MAX_CLAIM_BYTES,
              ))) throw new Error("The Windows recovery ownership state changed.");
          },
        },
      )) return false;
    }
    return true;
  } catch {
    return false;
  }
}
