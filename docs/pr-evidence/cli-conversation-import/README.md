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

- The importer is an 820px gallery, at most 80% of the viewport tall. Its
  first row is a borderless search field with a quiet "All · Codex · Claude"
  text toggle (`aria-pressed`), an icon-only "Scan again" button that spins
  while scanning, and the shared close button.
- Each conversation is a card in a two-column grid (one column when the
  dialog is narrower than 720px): the title, a miniature of the first request
  and reply in the transcript styling that fades into the card, and the date,
  time and "Imported" beside a small provider logo. A large provider logo
  sits in the corner at low opacity. Cards lift on hover and reveal with a
  short stagger. Miniatures come from the opening exchange in the scan, so
  the gallery makes no extra requests.
- Cards are buttons in a list, named by title, provider, full date and
  import state; the miniature is hidden from assistive technology. Arrow
  Down from the search field reaches the first card and arrow keys move
  between cards.
- Choosing a card crossfades into the full conversation with a back control,
  the title, the transcript and the import button. The view always fetches a
  fresh preview so an import uses the current revision. Escape goes back to
  the gallery and returns focus to the card; Escape in the gallery closes the
  importer.
- After an import the button becomes "Open chat", which closes the importer
  and opens the chat. Cmd+Enter on macOS or Ctrl+Enter elsewhere runs the
  button. "Already imported" stays a quiet secondary button; busy buttons
  use `aria-disabled`, so focus stays put.
- Empty, scanning and error states are one centred muted sentence, and all
  motion is off under reduced motion.
- The settings entry is one Row in the Checkout card: "Import Codex and
  Claude Code conversations started in this checkout."

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
