# Local database recovery and durability

## Status

**Not implemented.** This finding was confirmed against the current code but no
recovery mechanism was built in this pass. This document records the confirmed
state, the design, and why it was deferred, so the gap is visible rather than
silently dropped.

## Confirmed current state

`src/server/database.ts` sets, in this order:

```js
this.database.pragma("foreign_keys = ON");
this.database.pragma("busy_timeout = 5000");
this.database.pragma("journal_mode = WAL");
this.database.pragma("synchronous = NORMAL");
```

The existing comment is accurate: `NORMAL` in WAL mode keeps committed
transactions crash-consistent for a process crash, but a host power loss can lose
the newest OS-buffered commits.

What does **not** exist today:

- no backups of any kind, rotating or otherwise;
- no integrity check on open, and no recovery path when the main database cannot
  be opened — `RuntimeStore`'s constructor closes the handle and rethrows, so the
  runtime fails to start;
- no user-visible export of projects and conversations;
- no diagnostics describing a restore.

So corruption, accidental deletion of `inertia.sqlite`, or power loss during a
write currently has no in-app recovery story beyond whatever the user's own
filesystem backups provide.

## Design

### Rotating backups

Use `better-sqlite3`'s online `backup()` API rather than copying files, so WAL
content is included and no separate WAL handling is needed:

- write to `backups/inertia-<utc-timestamp>.sqlite.partial` in a directory
  sibling to the live database, never inside it;
- on success, run `PRAGMA integrity_check` **and** a schema-version read on the
  partial file, and only then rename it to `.sqlite`. The rename is the atomic
  commit point, so an interrupted rotation leaves a `.partial` file that the next
  run deletes;
- retain at most 5 backups and at most 512 MiB total, evicting oldest-first, and
  always keep at least one validated backup even if it exceeds the size bound
  (a too-large single backup is better than none);
- schedule on a timer (hourly while the app is running) plus one on clean
  shutdown; never on the streaming write path.

Separation is explicit: the live database, its `-wal` and `-shm` files, and the
`backups/` directory are distinct paths, and backups are never opened read-write
by the running app.

### Recovery path

On startup, before `migrate()`:

1. try to open the live database and run `PRAGMA quick_check`;
2. on failure, move the unreadable database aside to
   `corrupt/inertia-<timestamp>.sqlite` — never delete it, it may be the only
   copy of recent work;
3. walk backups newest-first, validating each with `integrity_check` plus a
   schema read, and restore the first that passes;
4. if none pass, start from an empty database;
5. record which backup was restored, or that none was, in runtime diagnostics so
   the user can see what happened and how much history was lost.

### Selective durability

Rather than moving everything to `synchronous = FULL`, wrap only the boundaries
where losing the newest commit is user-visible or authority-relevant:

- finalizing a user-authored message;
- completing an assistant response;
- applying a migration;
- changing remote grants;
- persisting critical ownership metadata.

Implement as `PRAGMA synchronous = FULL` around that single transaction, then
back to `NORMAL`, or as an explicit `wal_checkpoint(FULL)` after it. **Measure
before and after** — streamed token updates are frequent enough that a blanket
change is the wrong trade, and this proposal is unverified until benchmarked.

### Export

A user-visible JSON export of projects and conversations, deliberately excluding
credentials, secret references, provider tokens, attachment bytes, and vault
contents. The export must reuse the same projection discipline as the remote
transcript path so it cannot become a new exfiltration surface, and import must
validate against a strict schema and create new identities rather than
overwriting existing ones.

## Why deferred

This is a feature-sized change with its own failure modes — a backup that
silently produces corrupt copies, or a recovery path that discards good data, is
worse than no backups. It needs the measurement work above, fault-injection tests
that terminate the process mid-write, corrupt-file fixtures, and interrupted
rotation tests to be trustworthy. Landing it half-done alongside the remote and
runtime security work in this pass would have added risk to both.

## Required tests when implemented

- process termination during a write leaves a database that opens and passes
  `integrity_check`;
- a deliberately corrupted main database triggers restore from the newest valid
  backup, and the corrupt file is preserved rather than deleted;
- an invalid backup is skipped and an older valid backup is used;
- an interrupted rotation (`.partial` present) is cleaned up and does not count
  toward retention;
- WAL and shm files present at backup time do not produce a truncated backup;
- retention respects both the count and the total-size bound, and never leaves
  zero validated backups;
- export/import round-trips projects and conversations;
- no export contains credentials, secret references, or vault material.
