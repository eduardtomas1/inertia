import {
  directRuntimeJournalRootIsPinned,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  renameDirectRuntimeJournalLeaf,
  unlinkDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
} from "../node/direct-runtime-journal.js";
import {
  appUpdateHandoffTokenReceiptForSnapshot,
  appUpdateHandoffTokenReceiptMatches,
  appUpdateHandoffTokenReceiptsEqual,
  parseAppUpdateHandoffTokenReceipt,
  serializeAppUpdateHandoffTokenReceipt,
  type AppUpdateHandoffJournalOptions,
  type AppUpdateHandoffSnapshot,
  type AppUpdateHandoffTokenReceipt,
} from "./app-update-handoff.js";

const TOKEN_RECEIPT_PREFIX = ".app-update-secret";
const TOKEN_RECEIPT_CANONICAL = `${TOKEN_RECEIPT_PREFIX}.json`;
const TOKEN_RECEIPT_CLAIMED = `${TOKEN_RECEIPT_PREFIX}.claimed`;
const TOKEN_RECEIPT_TEMPORARY = `${TOKEN_RECEIPT_PREFIX}.publish.tmp`;
const MAX_TOKEN_RECEIPT_BYTES = 1_024;
const MAX_TOKEN_RECEIPT_LEAVES = 3;

export interface AppUpdateHandoffTokenClaim {
  readonly token: string;
  commit(): boolean;
  rollback(): boolean;
}

/**
 * Stores the Windows cross-process handoff secret in a direct, owner-only
 * leaf. Claim recovery is intentionally explicit: callers may recover an
 * abandoned claim only after acquiring the application's singleton lock.
 */
export class AppUpdateHandoffTokenVault {
  private readonly root: DirectRuntimeJournalRoot;
  private readonly clock: () => Date;
  private readonly hooks: AppUpdateHandoffJournalOptions["testHooks"];

  constructor(
    dataDirectory: string,
    options: AppUpdateHandoffJournalOptions = {},
  ) {
    this.root = pinDirectRuntimeJournalRoot(dataDirectory);
    this.clock = options.clock ?? (() => new Date());
    this.hooks = options.testHooks;
  }

  private names(): string[] {
    if (!directRuntimeJournalRootIsPinned(this.root)) {
      throw new Error("The app update token vault root identity changed.");
    }
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      TOKEN_RECEIPT_PREFIX,
      MAX_TOKEN_RECEIPT_LEAVES,
    );
    for (const name of names) {
      if (
        name !== TOKEN_RECEIPT_CANONICAL
        && name !== TOKEN_RECEIPT_CLAIMED
        && name !== TOKEN_RECEIPT_TEMPORARY
      ) throw new Error("The app update token vault contains a foreign entry.");
    }
    return names;
  }

  private read(
    name: typeof TOKEN_RECEIPT_CANONICAL
      | typeof TOKEN_RECEIPT_CLAIMED
      | typeof TOKEN_RECEIPT_TEMPORARY,
  ): {
    readonly leaf: DirectRuntimeJournalLeaf;
    readonly receipt: AppUpdateHandoffTokenReceipt;
  } | null {
    const leaf = readDirectRuntimeJournalLeaf(
      this.root,
      name,
      MAX_TOKEN_RECEIPT_BYTES,
      this.hooks,
    );
    if (!leaf) return null;
    const receipt = parseAppUpdateHandoffTokenReceipt(leaf.bytes);
    if (!receipt) throw new Error("The app update token receipt is invalid.");
    return { leaf, receipt };
  }

  private recoverPublisher(): void {
    const names = this.names();
    if (!names.includes(TOKEN_RECEIPT_TEMPORARY)) return;
    const publishing = this.read(TOKEN_RECEIPT_TEMPORARY);
    if (!publishing) return;
    const canonical = this.read(TOKEN_RECEIPT_CANONICAL);
    if (canonical) {
      if (!appUpdateHandoffTokenReceiptsEqual(
        canonical.receipt,
        publishing.receipt,
      )) throw new Error("App update token publishers conflict.");
      if (!unlinkDirectRuntimeJournalLeaf(
        this.root,
        TOKEN_RECEIPT_TEMPORARY,
        publishing.leaf.identity,
        this.hooks,
      )) throw new Error("The app update token publisher could not be retired.");
      return;
    }
    if (names.includes(TOKEN_RECEIPT_CLAIMED)) {
      throw new Error("The app update token publisher conflicts with a claim.");
    }
    if (!renameDirectRuntimeJournalLeaf(
      this.root,
      TOKEN_RECEIPT_TEMPORARY,
      TOKEN_RECEIPT_CANONICAL,
      publishing.leaf.identity,
      this.hooks,
    )) throw new Error("The app update token publisher could not be recovered.");
  }

  private current(): {
    readonly name: typeof TOKEN_RECEIPT_CANONICAL
      | typeof TOKEN_RECEIPT_CLAIMED;
    readonly leaf: DirectRuntimeJournalLeaf;
    readonly receipt: AppUpdateHandoffTokenReceipt;
  } | null {
    this.recoverPublisher();
    const names = this.names();
    if (
      names.includes(TOKEN_RECEIPT_CANONICAL)
      && names.includes(TOKEN_RECEIPT_CLAIMED)
    ) throw new Error("App update token authorities conflict.");
    const name = names.includes(TOKEN_RECEIPT_CLAIMED)
      ? TOKEN_RECEIPT_CLAIMED
      : names.includes(TOKEN_RECEIPT_CANONICAL)
        ? TOKEN_RECEIPT_CANONICAL
        : null;
    if (!name) return null;
    const current = this.read(name);
    return current ? { name, ...current } : null;
  }

  publish(snapshot: AppUpdateHandoffSnapshot, handoffToken: string): boolean {
    if (snapshot.phase !== "prepared") return false;
    const receipt = appUpdateHandoffTokenReceiptForSnapshot(
      snapshot,
      handoffToken,
    );
    if (!receipt) return false;
    const current = this.current();
    if (current) {
      return current.name === TOKEN_RECEIPT_CANONICAL
        && appUpdateHandoffTokenReceiptsEqual(current.receipt, receipt);
    }
    if (!writeDirectRuntimeJournalLeaf(
      this.root,
      TOKEN_RECEIPT_TEMPORARY,
      TOKEN_RECEIPT_CANONICAL,
      serializeAppUpdateHandoffTokenReceipt(receipt),
      this.hooks,
    )) return false;
    const committed = this.current();
    return !!committed
      && committed.name === TOKEN_RECEIPT_CANONICAL
      && appUpdateHandoffTokenReceiptsEqual(committed.receipt, receipt);
  }

  matches(snapshot: AppUpdateHandoffSnapshot): boolean {
    const current = this.current();
    return !!current
      && appUpdateHandoffTokenReceiptMatches(current.receipt, snapshot);
  }

  claim(
    snapshot: AppUpdateHandoffSnapshot,
    options: { readonly recoverAbandonedClaim?: boolean } = {},
  ): AppUpdateHandoffTokenClaim | null {
    let current = this.current();
    if (
      !current
      || !appUpdateHandoffTokenReceiptMatches(current.receipt, snapshot)
      || this.clock().getTime() > Date.parse(current.receipt.deadlineAt)
      || (
        current.name === TOKEN_RECEIPT_CLAIMED
        && options.recoverAbandonedClaim !== true
      )
    ) return null;
    if (current.name === TOKEN_RECEIPT_CANONICAL) {
      if (!renameDirectRuntimeJournalLeaf(
        this.root,
        TOKEN_RECEIPT_CANONICAL,
        TOKEN_RECEIPT_CLAIMED,
        current.leaf.identity,
        this.hooks,
      )) return null;
      const claimed = this.read(TOKEN_RECEIPT_CLAIMED);
      if (
        !claimed
        || !appUpdateHandoffTokenReceiptsEqual(
          claimed.receipt,
          current.receipt,
        )
      ) return null;
      current = { name: TOKEN_RECEIPT_CLAIMED, ...claimed };
    }
    const owned = current;
    let state: "claimed" | "committed" | "rolled-back" = "claimed";
    return Object.freeze({
      token: owned.receipt.handoffToken,
      commit: (): boolean => {
        if (state === "committed") return true;
        if (state !== "claimed") return false;
        const latest = this.read(TOKEN_RECEIPT_CLAIMED);
        if (
          !latest
          || !appUpdateHandoffTokenReceiptsEqual(
            latest.receipt,
            owned.receipt,
          )
        ) return false;
        const committed = unlinkDirectRuntimeJournalLeaf(
          this.root,
          TOKEN_RECEIPT_CLAIMED,
          latest.leaf.identity,
          this.hooks,
        );
        if (committed) state = "committed";
        return committed;
      },
      rollback: (): boolean => {
        if (state === "rolled-back") return true;
        if (state !== "claimed") return false;
        const latest = this.read(TOKEN_RECEIPT_CLAIMED);
        if (
          !latest
          || !appUpdateHandoffTokenReceiptsEqual(
            latest.receipt,
            owned.receipt,
          )
        ) return false;
        const rolledBack = renameDirectRuntimeJournalLeaf(
          this.root,
          TOKEN_RECEIPT_CLAIMED,
          TOKEN_RECEIPT_CANONICAL,
          latest.leaf.identity,
          this.hooks,
        );
        if (rolledBack) state = "rolled-back";
        return rolledBack;
      },
    });
  }

  discard(snapshot: AppUpdateHandoffSnapshot): boolean {
    const current = this.current();
    if (!current) return true;
    if (!appUpdateHandoffTokenReceiptMatches(current.receipt, snapshot)) {
      return false;
    }
    return unlinkDirectRuntimeJournalLeaf(
      this.root,
      current.name,
      current.leaf.identity,
      this.hooks,
    );
  }
}
