import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitTransactionJournalAliasPath,
  observeCommitTransactionJournalSync,
  publishCommitTransactionJournal,
  removeOwnedCommitTransactionJournal,
  removeOwnedCommitTransactionJournalAlias,
  type CommitTransactionJournal,
} from "../../src/server/git/commit-transaction";

const roots: string[] = [];

function fixture(): {
  directory: string;
  journal: CommitTransactionJournal;
  journalPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "inertia-commit-journal-"));
  roots.push(directory);
  const indexPath = join(directory, "index");
  return {
    directory,
    journalPath: `${indexPath}.inertia-commit-transaction.json`,
    journal: {
      expectedHead: "1".repeat(40),
      headRef: "refs/heads/main",
      headPath: join(directory, "HEAD"),
      refPath: join(directory, "refs", "heads", "main"),
      newCommit: "2".repeat(40),
      oldIndexHash: "3".repeat(64),
      newIndexHash: "4".repeat(64),
      indexPath,
      stagePath: `${indexPath}.inertia-stage-${"5".repeat(32)}`,
      reservationToken: "6".repeat(64),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("reviewed commit journal ownership", () => {
  it("rejects an in-place journal mutation after publication", async () => {
    const { journal, journalPath } = fixture();
    const aliasPath = commitTransactionJournalAliasPath(
      journalPath,
      journal.reservationToken,
    );

    await expect(publishCommitTransactionJournal(journalPath, journal, {
      afterLink: (_temporaryPath, publishedPath) => {
        writeFileSync(publishedPath, "same-inode foreign journal");
      },
    })).rejects.toThrow(/could not be published atomically/iu);

    expect(readFileSync(journalPath, "utf8")).toBe("same-inode foreign journal");
    expect(readFileSync(aliasPath, "utf8")).toBe("same-inode foreign journal");
  });

  it.skipIf(process.platform === "win32")(
    "preserves a late replacement instead of unlinking it",
    async () => {
      const { journal, journalPath } = fixture();
      const owned = await publishCommitTransactionJournal(journalPath, journal);

      await expect(removeOwnedCommitTransactionJournal(
        journalPath,
        owned,
        () => {
          rmSync(journalPath);
          writeFileSync(journalPath, "late foreign journal", { flag: "wx" });
        },
      )).rejects.toThrow(/was replaced/iu);

      expect(readFileSync(journalPath, "utf8")).toBe("late foreign journal");
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a same-content journal published after validation",
    async () => {
      const { journal, journalPath } = fixture();
      const owned = await publishCommitTransactionJournal(journalPath, journal);

      await expect(removeOwnedCommitTransactionJournal(
        journalPath,
        owned,
        () => {
          rmSync(journalPath);
          writeFileSync(journalPath, owned.content, { flag: "wx" });
        },
      )).rejects.toThrow(/was replaced/iu);

      expect(readFileSync(journalPath)).toEqual(owned.content);
    },
  );

  it("keeps the journal when post-validation removal is unavailable", async () => {
    const { journal, journalPath } = fixture();
    const owned = await publishCommitTransactionJournal(journalPath, journal);

    await expect(removeOwnedCommitTransactionJournal(
      journalPath,
      owned,
      () => {
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      },
    )).rejects.toThrow("sharing violation");

    expect(readFileSync(journalPath)).toEqual(owned.content);
  });

  it("preserves a foreign replacement of a pre-link alias", async () => {
    const { journal, journalPath } = fixture();
    const aliasPath = commitTransactionJournalAliasPath(
      journalPath,
      journal.reservationToken,
    );

    await expect(publishCommitTransactionJournal(journalPath, journal, {
      beforeLink: (temporaryPath) => {
        rmSync(temporaryPath);
        writeFileSync(temporaryPath, "foreign pre-link alias", { flag: "wx" });
        throw new Error("simulated pre-link failure");
      },
    })).rejects.toThrow(/was replaced/iu);

    expect(readFileSync(aliasPath, "utf8")).toBe("foreign pre-link alias");
    expect(existsSync(journalPath)).toBe(false);
  });

  it("cleans an exact crash alias but preserves a foreign alias", async () => {
    const { journal, journalPath } = fixture();
    const aliasPath = commitTransactionJournalAliasPath(
      journalPath,
      journal.reservationToken,
    );

    await expect(publishCommitTransactionJournal(journalPath, journal, {
      afterLink: () => {
        throw new Error("simulated crash after journal link");
      },
    })).rejects.toThrow("simulated crash after journal link");

    const observed = observeCommitTransactionJournalSync(journalPath);
    expect(observed).not.toBeNull();
    await removeOwnedCommitTransactionJournalAlias(
      journalPath,
      journal.reservationToken,
      observed!,
    );
    expect(existsSync(aliasPath)).toBe(false);
    expect(observeCommitTransactionJournalSync(journalPath)).toEqual(observed);

    writeFileSync(aliasPath, "foreign alias", { flag: "wx" });
    await expect(removeOwnedCommitTransactionJournalAlias(
      journalPath,
      journal.reservationToken,
      observed!,
    )).rejects.toThrow(/foreign journal publication alias/iu);
    expect(readFileSync(aliasPath, "utf8")).toBe("foreign alias");
  });

  it("rejects an oversized journal before publishing any path", async () => {
    const { journal, journalPath } = fixture();
    journal.headRef = `refs/heads/${"x".repeat(4_096)}`;
    const aliasPath = commitTransactionJournalAliasPath(
      journalPath,
      journal.reservationToken,
    );

    await expect(publishCommitTransactionJournal(journalPath, journal))
      .rejects.toMatchObject({ code: "output-limit" });

    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(aliasPath)).toBe(false);
  });
});
