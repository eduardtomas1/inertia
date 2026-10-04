# Settings after the rework

Screenshots of the built app at commit `12e3ed5c` on
`feat/settings-rework`. They are the "after" half of every pair in the rework
PR; the "before" half is in [`../before`](../before/README.md), captured from
main at `1053edf2` by the same spec. [`../README.md`](../README.md) maps each
change to its pair.

## Platform

- macOS 27.0.1 (26A434), Apple M5 Pro, arm64
- Electron 44.4.5, Node.js 22
- Device scale 2 (built-in Retina display)
- Window sizes and image sizes: wide 1440 × 920 gives 2880 × 1736 (the page
  below the window frame), narrow 1000 × 800 gives 2000 × 1600, tight
  760 × 600 gives 1520 × 1200

## Fixture

`tests/e2e/settings-evidence.spec.ts` launches the same isolated fixture as
the before set, with synthetic data only: the standard conversation fixture,
23 projects (one with an 80-character name), the three validation diagnostics
plus the fake signed-out Claude's, a fake Codex app server with two models,
no real provider CLI, the page clock frozen at 2026-10-03 10:30 UTC,
animations disabled and the pointer parked.

One difference: the fixture archives 26 chats instead of 18. The extra eight
("Archived follow-up 1" to "8") push the list past one page of 20, so paging
can be shown.

The new-chat fallback (`chats-new-chats-fallback-light-wide.png`) comes from a
second, smaller launch in the same spec: the conversation fixture with the
stored default provider set to the fake signed-out Claude. The main fixture
stays as it was so every pair compares like with like.

Values read from the machine still vary between runs: diagnostic timestamps,
backup time, memory and disk figures, the update check message and provider
maintenance versions.

## Coverage

Names follow `<section>-<state>[-p<page>]-<theme>-<size>.png`, with the nine
new section ids (`appearance`, `chats`, `notifications`, `keyboard`,
`projects`, `agents`, `devices`, `data`, `help`). Entry and exit images keep
the before names, so those pairs share a file name.

- Light wide is the complete reference: every group of every section, one
  image per scrolled page, and every state below.
- Dark wide: one image per group where groups start on a new screen.
- Dark narrow and dark 760 × 600: one image per section, plus Help ›
  Diagnostics.
- A group that starts below the last scroll position appears in the previous
  group's image (for example Review and terminal is in `chats-transcript-*`,
  Working indicator is in `appearance-scale-*`, the whole Notifications
  section is in `notifications-alerts-*`, Discord is in `devices-snapshots-*`
  and About and updates is in `help-support-*`).

New surfaces, light wide unless named:

- Search in Settings: results for "sound", a result focused with the arrow
  keys, the row opened with Enter, "No settings match", and results at
  1000 × 800 (`search-results-dark-narrow`).
- The palette: "theme" finds the Mode row (`entry-palette-theme`) and opens
  Appearance at it (`entry-palette-theme-opened`).
- Leaving and entering with ⌘, (`exit-shortcut`, `entry-shortcut`), Escape
  (`exit-escape`) and reopening on the last section (`exit-reopened`).
- Notifications in forced colours, switch states distinguishable
  (`notifications-alerts-forced-colours`).
- The inline Restore defaults confirmation with Cancel focused
  (`data-restore-confirm`).
- Saved feedback in a row (`chats-saved`, `projects-default-access-saved`).
- Errors in a row: `projects-spend-limit-invalid`,
  `devices-discord-invalid-url` and `devices-discord-error` (posting without a
  repository URL). A failed save ("Couldn't save. Try again.") cannot happen
  in the fixture without fault injection; the Happy DOM tests in
  `tests/renderer/settings-saving.dom.test.tsx` and
  `tests/renderer/settings-primitives.dom.test.tsx` cover it.
- The Discord post confirmation (`devices-discord-post-confirm`).
- Archived chats: first and second page, the filter, and the list after "Show
  N more".
- New setting rows: background-only notifications, quota warnings, Show
  mascot and Animate mascot (`notifications-alerts`), project default
  access (`projects-default-access-saved`), repository display limit
  (`projects-advanced`).
- New chats with the provider fallback (`chats-new-chats-fallback`); the
  inherited "Default (X)" values show in `projects-project-p2`.

| Section | Images |
| --- | --- |
| Appearance | 6 |
| Chats | 8 |
| Notifications | 5 |
| Keyboard | 4 |
| Projects | 10 |
| Agents | 9 |
| Devices & integrations | 9 |
| Data | 14 |
| Help | 11 |
| Search in Settings | 5 |
| Entry and exit | 10 |

91 images, about 30 MB (the before set has 82 images, about 28 MB).

## Rerun

The capture tests are skipped unless `INERTIA_SETTINGS_EVIDENCE_DIR` is set;
the directory is resolved from the working directory. From the repository
root:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci
npm run build:bundle
INERTIA_SETTINGS_EVIDENCE_DIR=docs/pr-evidence/settings/after \
  npx playwright test tests/e2e/settings-evidence.spec.ts --max-failures=1
```

Without the variable the spec still runs its quick check that Settings fits a
760 × 600 window without page overflow.
