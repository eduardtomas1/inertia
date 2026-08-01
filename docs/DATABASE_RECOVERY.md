# Local database recovery and durability

## Implemented behavior

Inertia keeps the live SQLite database in WAL mode with `synchronous = NORMAL`.
That existing durability policy is unchanged: process crashes remain
transactionally safe, while a sudden host power loss can still lose the newest
OS-buffered commits. Recovery is provided by validated rotating backups rather
than by adding a full filesystem sync to every streamed update.

At runtime, Inertia creates an online backup every hour and one more during a
clean shutdown. `better-sqlite3`'s online backup API includes committed WAL data
without racing a file copy. Backups are written beside the primary database:

- `backups/inertia-<UTC timestamp>.sqlite.partial` while in progress;
- `backups/inertia-<UTC timestamp>.sqlite` only after `PRAGMA integrity_check`
  and a supported schema-version check pass;
- at most five validated backups and 512 MiB in total, evicting oldest first;
- at least one validated backup is retained even if that one file is larger
  than the byte budget.

Interrupted `.partial` backup and restore files are removed on the next startup.
The data, backup, recovery, and corruption directories are owner-only (`0700`)
and their artifacts are owner-readable/writable (`0600`) on POSIX systems.

## Startup recovery

Recovery runs before the database is opened for migration:

1. Open the primary database read-only and run `PRAGMA quick_check`.
2. If it fails, move the primary plus any WAL/SHM sidecars to `corrupt/`. The
   unreadable source is preserved and is never replaced or deleted as cleanup.
3. Validate backups newest-first with `integrity_check` and a schema read, skip
   invalid candidates, and atomically restore the newest valid one.
4. Run ordinary append-only migrations on the restored database.
5. If no backup passes validation, initialize a new empty database while still
   preserving the corrupt primary.

A restore or empty fallback is recorded in
`recovery/last-database-recovery.json` and carried through the supervised
runtime protocol into privacy-filtered lifecycle diagnostics. It contains only
the outcome, trigger, backup filename, corruption-preservation flag, validation
count, and timestamp—never paths, transcripts, or credentials.

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

Import validates the complete document before a transaction begins, creates new
project/conversation/message identities, and leaves the user's current active
selection unchanged. Any failure rolls the import back in full.

## Fault coverage

Automated coverage exercises committed WAL backup, corrupt-primary quarantine,
newest-valid and older-valid restore, no-valid-backup initialization,
interrupted partial cleanup, count/byte retention, clean-shutdown backup,
owner-only permissions, strict export/import rollback and containment, abrupt
`SIGKILL` recovery, schema-37 upgrade, durable stream restart, and injected
terminal-compaction rollback. Platform-independent scheduler and path tests run
under the repository's Linux, macOS, and Windows CI matrix.
