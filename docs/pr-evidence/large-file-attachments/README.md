# Large file attachments

Real screenshots of the built Electron app on macOS 27.0.1 (arm64) at device
scale 2, captured by `tests/e2e/large-file-attachments.spec.ts` with
`animations: "disabled"` and a frozen clock. The spec drops synthetic files on
the composer (a generated PNG, a one-page PDF, Markdown, a 14-byte `.tar.zst`,
a 1.2 MB log with an 80-character name), pastes 40 KiB of text, holds the
privileged commit of a further `.parquet` upload to show it in flight, and
drops a 50 MiB + 1 byte file to show the rejection. No live profile,
credentials, provider CLI or user content is used. The same spec asserts the
composer dock invariant (`expectComposerEndsAtDock`), no viewport or chip-list
overflow, no nested buttons, a visible (not covered) truncation notice and the
storage copy, so the screenshots are also tests.

"Before" is the branch at `c324eb89`; "after" is this change. Sizes: wide is
1440 × 920, narrow is 1000 × 800, tight is 760 × 600.

## Truncated text preview

Text previews read the first 1 MiB. The notice that says so was rendered behind
the absolutely positioned text block, so it was never visible. It is now a quiet
row under the scrollable text, aligned with the text's left edge, separated by
a hairline. A truncated CSV says the same once, in the workbook's existing note
row, instead of adding a second note.

| Before | After |
| --- | --- |
| ![Before: truncated dark](before-preview-truncated-dark-wide.png) | ![After: truncated dark](preview-truncated-dark-wide.png) |
| ![Before: truncated light](before-preview-truncated-light-wide.png) | ![After: truncated light](preview-truncated-light-wide.png) |
| ![Before: truncated tight](before-preview-truncated-dark-760x600.png) | ![After: truncated tight](preview-truncated-dark-760x600.png) |

## Opaque file preview

A file with no previewable type showed one bare sentence on the stage. It now
uses the dialog's existing "Preview unavailable" layout (icon, title, one
sentence), without the alert role because nothing failed, and a generic file
icon instead of the text-document icon in the header.

| Before | After |
| --- | --- |
| ![Before: file dark](before-preview-file-dark-wide.png) | ![After: file dark](preview-file-dark-wide.png) |
| ![Before: file light](before-preview-file-light-wide.png) | ![After: file light](preview-file-light-wide.png) |
| ![Before: file tight](before-preview-file-dark-760x600.png) | ![After: file tight](preview-file-dark-760x600.png) |

## Composer attachments

Opaque files use a generic file icon in composer chips and sent tiles, so a
`.tar.zst` no longer looks like a text document. Truncated chip names show the
full name on hover, as sent tiles already did.

| Before | After |
| --- | --- |
| ![Before: composer dark](before-composer-attachments-dark-wide.png) | ![After: composer dark](composer-attachments-dark-wide.png) |
| ![Before: composer tight](before-composer-attachments-dark-760x600.png) | ![After: composer tight](composer-attachments-dark-760x600.png) |

After only: [light wide](composer-attachments-light-wide.png),
[light narrow](composer-attachments-light-narrow.png),
[dark narrow](composer-attachments-dark-narrow.png),
upload in flight [dark](composer-upload-pending-dark-wide.png) and
[light](composer-upload-pending-light-wide.png) (the list is scrolled to the
pending chip; "Adding attachments…" shows in the toolbar).

## Rejected file

The rejection now says what happened to the rest of the drop: "An attachment is
empty or larger than the 50 MiB file limit. No files were attached." The file
name stays out of the message because app errors can reach diagnostics.

| Before | After |
| --- | --- |
| ![Before: rejected light](before-composer-rejected-light-wide.png) | ![After: rejected light](composer-rejected-light-wide.png) |

After only: [dark](composer-rejected-dark-wide.png).

## Attachment storage settings

The temporary budget for unsent attachments read "1 GiB"; the registry enforces
16 GiB (`MAX_SESSION_ATTACHMENT_BYTES` in `src/main/attachment-registry.ts`).
The per-message limits are one sentence shorter and name "Images" once. The
before captures stop at the card's first scroll position; the after captures
scroll the card to the top.

| Before | After |
| --- | --- |
| ![Before: storage dark](before-storage-settings-dark-wide.png) | ![After: storage dark](storage-settings-dark-wide.png) |
| ![Before: storage narrow](before-storage-settings-light-narrow.png) | ![After: storage narrow](storage-settings-light-narrow.png) |

After only: [light wide](storage-settings-light-wide.png),
[dark narrow](storage-settings-dark-narrow.png).
