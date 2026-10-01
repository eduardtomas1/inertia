# Import CLI conversations

Real screenshots of the built Electron app on macOS 27.0.1 (arm64, device
scale 2), captured by `tests/e2e/cli-conversation-import.spec.ts` with
`animations: "disabled"`. The spec writes synthetic Codex and Claude Code
transcripts into temporary `CODEX_HOME` and `CLAUDE_CONFIG_DIR` folders and
renames the fixture project through `RuntimeStore`. No live profile,
credentials, provider CLI or user history is used. Dates follow the machine
locale.

The second test in the spec ("captures the importer in light, dark, narrow,
empty and error states") is also a layout test: at every capture the dialog
must sit fully in the viewport, the page must not overflow, no button may
contain another button, nothing inside the dialog may scroll sideways, and no
candidate or preview title may be clipped.

## What changed

- The dialog is a portalled `.dialog-backdrop` dialog like the file editor:
  a 36px `.dialog-icon`, "Import CLI conversations" as the heading that names
  it, one muted line naming the project, and the shared `IconButton` close.
  It no longer inherits the Project settings button styles.
- The search field, provider select and "Scan again" share one 32px control
  height, the form-field border and fill, and one focus ring.
- The list label is sentence case ("3 conversations"). Rows are plain
  buttons: provider glyph, title that wraps in full, and one meta line
  ("Codex · 25 Sep 2026 · Imported"). Selection uses the shared selected
  surface, with no accent border.
- User messages in the preview use the timeline's user-request tint, aligned
  right; replies are plain text under the provider name.
- Scan notes (limited scan, skipped files) sit under the list label.
  Failures, the import result and the session note share the footer's status
  line, so nothing above the panes moves. Diagnostic incident references are
  left to the app-level error toast.
- "Already imported" is a quiet secondary button. Busy and unavailable
  buttons use `aria-disabled`, so keyboard focus stays on "Import
  conversation" through "Importing…" and "Already imported".
- The settings entry is one Row in the existing Checkout card instead of a
  card of its own.
- All sizes come from the font, radius, control-height and motion tokens; the
  stylesheet is multi-line and has no literal colours or shadows.

## Before and after

Before is `0609e195` (the PR head before this polish).

| Before | After |
| --- | --- |
| ![Before: settings](before-settings-row-light-wide.png) | ![After: settings](settings-row-light-wide.png) |
| Settings, 1440 × 920 light | Settings, 1440 × 920 light |
| ![Before: idle](before-dialog-idle-light-wide.png) | ![After: idle](dialog-idle-light-wide.png) |
| Nothing selected, 1440 × 920 light | Nothing selected, 1440 × 920 light |
| ![Before: preview](before-dialog-preview-dark-wide.png) | ![After: preview](dialog-preview-dark-wide.png) |
| Preview, 1440 × 920 dark | Preview, 1440 × 920 dark |
| ![Before: tight](before-dialog-preview-dark-760x600.png) | ![After: tight](dialog-preview-dark-760x600.png) |
| Preview, 760 × 600 dark | Preview, 760 × 600 dark |
| ![Before: long title](before-dialog-long-title-light-narrow.png) | ![After: long title](dialog-long-title-light-narrow.png) |
| 128-character title, 1000 × 800 light (clipped to two lines) | 128-character title, 1000 × 800 light |
| ![Before: error](before-dialog-error-light-wide.png) | ![After: error](dialog-error-light-wide.png) |
| Unreadable file and failed preview, 1440 × 920 light | Unreadable file and failed preview, 1440 × 920 light |
| ![Before: empty](before-dialog-empty-dark-wide.png) | ![After: empty](dialog-empty-dark-wide.png) |
| No history, 1440 × 920 dark | No history, 1440 × 920 dark |

## Other after captures

| Light | Dark |
| --- | --- |
| ![Preview, narrow light](dialog-preview-light-narrow.png) | ![Preview, narrow dark](dialog-preview-dark-narrow.png) |
| ![Preview at 1280 × 920, light](preview-light.png) | ![Already imported at 1280 × 920, dark](imported-dark.png) |
| ![Error, light](dialog-error-light-wide.png) | ![Error, dark](dialog-error-dark-wide.png) |
| ![Settings, light](settings-row-light-wide.png) | ![Settings, dark](settings-row-dark-wide.png) |

`preview-light.png` (1280 × 920), `imported-dark.png` (1280 × 920) and
`compact-dark.png` (900 × 700) come from the first test, which imports both
histories, restarts the app and resumes the original Codex session.
`dialog-empty-dark-760x600.png` shows the empty state at the tight size.
