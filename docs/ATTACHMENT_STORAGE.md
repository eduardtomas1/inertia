# Attachment storage

Settings → Archive & data → **Attachment storage · all chats** controls originals
retained by this Inertia profile. Images and documents share this space across
active and archived chats. The existing Local resource health panel separately
reports app RAM, database size, browser cache and temporary attachment bytes.

## Disk capacity and ownership

| Resource | Previous | Current |
| --- | --- | --- |
| Retained original file bytes, all chats | 2 GiB | 16 GiB default; choose 2, 4, 8, 16, 32 or 64 GiB |
| Retained file count, all chats | 4,096 | 65,536 |
| Temporary original file bytes | 512 MiB | 1 GiB |
| Temporary file count | 256 | 1,024 |
| Automatic eviction when full | Enabled | Off by default; explicit opt-in with confirmation |

16 GiB gives eight times the previous disk capacity (roughly 1,638 files at the
10 MiB maximum). The 64 GiB ceiling permits larger local collections while
retaining a finite quota. The larger count guard allows small screenshots to
use that disk budget instead of hitting the old 4,096-image ceiling. No space
is preallocated. Quotas count original file bytes; filesystem allocation,
directories and small metadata sidecars use additional disk space.

Budget changes take effect immediately and persist across restart. Lowering a
budget preserves all existing files, including when current usage exceeds it.
New imports stop at capacity unless automatic removal is explicitly enabled.
Before admitting new retained bytes, Inertia checks free space, reserves
512 MiB for other work, and includes a 64 KiB allocation allowance per new or
pending file. Other apps can still change available disk space during a write;
failed writes use the existing rollback and restart reconciliation paths.

**Remove oldest files** previews the count and bytes of the next batch (up to
64 files). Confirmation explains that originals in finished chats, including
archived chats, will be deleted while their messages remain. Cleanup protects
all attachments in chats with active or queued turns and in-flight retentions,
rechecks eligibility during deletion,
and shares the import mutation queue. If cleanup fails, refresh usage before
retrying: already removed files are accounted for, and unconfirmed cleanup
stays charged until safely reconciled.

Optional automatic removal uses the existing oldest-finished-chat policy
when a new retained batch needs room. Enabling it requires confirmation.
Deleting a chat continues to release files that no other chat references.
Abandoned temporary imports are cleaned up on restart; cancellation and removal
continue to release their owned files without affecting other drafts or chats.

## RAM and image constraints

The disk quota is independent of RAM. Raising it does not increase Electron's
heap, cache all stored images, or increase import concurrency. Retained storage
keeps a bounded metadata index and reads original bytes only when needed.
Startup reconciliation stays incremental; gallery images outside the visible
scroll area are unmounted, and only the newest 60 attachments are projected in
the gallery. Full originals remain available through message previews.

The following limits are unchanged:

- 8 attachments per message, 20 MiB total, 10 MiB per file.
- 40 megapixels per image, 8,192 pixels per side, 256 animation frames with a
  combined 40-megapixel decoded budget.
- One maximum-size RGBA decode represents 160,000,000 bytes (152.6 MiB), plus
  codec/runtime overhead. Up to two short-lived validation utilities may run.
- Imported file reads remain sequential, native selection copies use 64 KiB
  chunks, and pending temporary import payloads share a 20 MiB bound.
- Workspace file previews keep their separate 6-megapixel / 12-megapixel
  animation budget and 20 MiB active encoded-stream limit.

Provider limits remain independent. For example, [Claude's vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)
describe encoded-image and request-size limits, with lower limits on some
partner platforms. Inertia's storage setting does not change those limits or
provider/model image support. Originals, digest verification, safe-container
validation and symlink containment checks are preserved.

## Verification evidence

Focused coverage exercises quota changes, retained counts above 4,096,
cleanup/import serialization, active retention protection, low-disk rejection
before optional eviction, schema-79 upgrades, restart accounting, cancellation
and cleanup confirmation. Existing image validation covers 4K, 5K, 6K, 8K and
40-megapixel images plus malformed and near-limit rejection.

The Electron storage scenario checks two chats (one archived), cancellation,
settings persistence, explicit cleanup and unchanged renderer error state. The
40-megapixel gallery scenario records OS working-set samples while the original
is offscreen, open, then closed. These samples describe one local run, not a
cross-platform memory ceiling or a guarantee about Chromium's release timing.
