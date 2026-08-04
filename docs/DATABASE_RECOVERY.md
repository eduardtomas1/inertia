# Local database recovery and durability

## Implemented behavior

Inertia keeps the live SQLite database in WAL mode with `synchronous = NORMAL`.
That existing durability policy is unchanged: process crashes remain
transactionally safe, while a sudden host power loss can still lose the newest
OS-buffered commits. Recovery is provided by validated rotating backups rather
than by adding a full filesystem sync to every streamed update.

At runtime, Inertia creates an online backup every hour. Initial-timer,
first-settled-turn, hourly, and validation-retry triggers all enter one automatic
scheduler. The scheduler records the pending trigger kinds, deduplicates them
against one pending timer or in-flight backup, and starts only when the runtime
is quiet: no active turn, recovery import, recovery replacement, critical
settlement, or other backup is in flight. Every relevant settlement replaces
the interaction deadline with a full grace period measured from that latest
settlement. Validation retry backoff has a separate deadline; an automatic
backup waits for both deadlines, so a generic eligibility retry cannot shorten
either one.

An explicit manual backup has deliberately different semantics: after
deduplicating with an in-flight backup, it starts immediately instead of being
held behind an unbounded interaction wait. Its successful publication also
satisfies any automatic request that raced it. Clean shutdown cancels pending
automatic timers and aborts unfinished backup work instead of starting a
database-sized operation inside the process-wide shutdown deadline.
`better-sqlite3`'s online backup API
includes committed WAL data without racing a file copy. Backups are written
beside the primary database:

- `backups/inertia-<UTC timestamp>.sqlite.partial` while in progress;
- `backups/inertia-<UTC timestamp>.sqlite` only after an off-event-loop
  `PRAGMA integrity_check`, exact contiguous migration-history check, and
  required-schema check pass;
- at most five validated backups and 512 MiB in total, evicting oldest first;
- at least one current validated backup is retained even if that one file is
  larger than the byte budget. Backups from a newer schema are protected from
  downgrade pruning and are never treated as corruption.

Validation failures remove partial files, leave `lastValidatedAt` unchanged,
and retry with bounded exponential backoff for a finite five-retry budget.
Interrupted `.partial` backup and restore files are removed on the next startup.
The data, backup, recovery, and corruption directories are owner-only (`0700`)
and their artifacts are owner-readable/writable (`0600`) on POSIX systems.

## Startup recovery

Recovery runs before the database is opened for migration:

1. Open the primary database read-only, run `PRAGMA quick_check`, and require a
   coherent released migration history and the schema required by that history.
2. If it fails, move the primary plus any WAL/SHM sidecars to `corrupt/`. The
   unreadable source is preserved and is never replaced or deleted as cleanup.
3. Validate backups newest-first with `integrity_check`, exact migration
   history, and required schema; skip corrupt candidates, preserve unsupported
   future candidates, and atomically restore the newest compatible one.
4. Run ordinary append-only migrations on the restored database.
5. If no compatible backup passes validation, initialize a new empty database
   while still preserving the corrupt primary. A clean first launch with no
   primary and no backup is a distinct non-incident outcome.

A restore or empty fallback is recorded in
`recovery/last-database-recovery.json` and carried through the supervised
runtime protocol into privacy-filtered lifecycle diagnostics. It contains only
the outcome, trigger, backup filename, corruption-preservation flag, validation
and unsupported-backup counts, and timestamp—never paths, transcripts, or
credentials.

## Explicit recovery export

Settings → Archive & data exposes a native save/open-dialog flow for recovery
JSON. The renderer never supplies a filesystem path. The utility runtime writes
exports through a private temporary file, `fsync`, and atomic rename; imports
reject symlinks, oversized files, malformed JSON, unknown keys, and changed
files.

The versioned strict format contains project names/paths, conversation routing
preferences, and user/assistant/system message text and timestamps. It
deliberately excludes:

- credentials, tokens, secret references, and credential-vault data;
- provider sessions and continuation identities;
- attachment metadata and bytes;
- execution manifests, source context, Git patches, and diagnostics.

Import validates the complete document before a transaction begins and asks the
user to authorize a destination folder separately from the recovery file.
Exported absolute paths and access grants are never trusted: projects are
remapped beneath that folder and every conversation returns to supervised
access. Imports create new project/conversation/message identities and leave
the user's current active selection unchanged. A durable content-and-destination
receipt makes a late retry idempotent, recovery operations are serialized, and
any failure rolls the import back in full.

## Fault coverage

Automated coverage exercises committed WAL backup, corrupt-primary quarantine,
newest-valid and older-valid restore, no-valid-backup initialization,
interrupted partial cleanup, count/byte retention, bounded shutdown
cancellation, future-schema preservation, owner-only permissions, strict and
idempotent export/import containment, abrupt `SIGKILL` recovery, schema-41
upgrade, oversized single-delta splitting, durable stream restart, and injected
terminal-compaction rollback. Scheduler regressions cover blocked hourly and
recovery-import triggers, initial/hourly and manual/hourly races, repeated
blocked ticks, rotation, shutdown cancellation, consecutive settlement grace
replacement, and the precedence of interaction grace over validation retry
backoff. Platform-independent scheduler and path tests run under the
repository's Linux, macOS, and Windows CI matrix.
