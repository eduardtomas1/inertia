# Settings before the rework

Screenshots of the built app at commit `1053edf2` (main before the Settings
rework). They are the "before" half of every pair in the rework PR. The
"after" half comes from the same spec on the rework branch.

## Platform

- macOS 27.0.1 (26A434), Apple M5 Pro, arm64
- Electron 44.4.5, Node.js 22
- Device scale 2 (built-in Retina display)
- Window sizes and image sizes: wide 1440 × 920 gives 2880 × 1736 (the page
  below the window frame), narrow 1000 × 800 gives 2000 × 1600, tight
  760 × 600 gives 1520 × 1200

## Fixture

`tests/e2e/settings-evidence.spec.ts` launches one isolated Electron fixture
with synthetic data only:

- the standard conversation fixture plus 23 projects, one of them with an
  80-character name (`customer-onboarding-experience-redesign-with-a-deliberately-long-project-name`)
- 18 archived chats, one with a long title
- three validation diagnostics (`discord.repository-missing`,
  `discord.webhook-missing`, `application.validation-failed`); the fake Claude
  adds a fourth, "Provider authentication is required"
- a fake Codex app server (two models) and a fake Claude that reports signed
  out; no real provider CLI runs, other providers show "CLI not found"
- page clock frozen at 2026-10-03 10:30 UTC, animations disabled, pointer
  parked at the corner and focus cleared unless focus is the subject

Values read from the machine at capture time still vary between runs:
diagnostic timestamps, backup time, memory and disk figures in Archive & data,
the update check message and provider maintenance versions.

## Coverage

Names follow `<section>-<state>[-p<page>]-<theme>-<size>.png`.

- Light wide is the complete reference: every state of every section, one
  image per scrolled page. General is captured card by card.
- Dark wide: one image per section, except General (one per card) and
  Archive & data (first page and the Local data page).
- Dark narrow and dark 760 × 600: one image per section.
- Entry and exit, light wide only: the chat, the palette with "settings" and
  "theme" typed, Settings opened from the palette, Escape pressed in
  Keybindings, leaving through Workspace and reopening.

A General card that starts below the last scroll position appears in the
previous card's image (Terminal and Application updates are in
`general-responses-*` at the wide size). `exit-reopened-light-wide.png` is
identical to `general-appearance-p1-light-wide.png` because reopening
Settings lands on General.

| Section | Images |
| --- | --- |
| General | 12 |
| Snapshots | 4 |
| Projects (All projects, the long-name project, Add action form, invalid spend limit) | 9 |
| Providers (Codex, Advanced open, Claude signed out, CLI not found) | 8 |
| Model backends (profile, New profile) | 7 |
| Connections & devices | 4 |
| Discord (default, invalid URL typed) | 5 |
| Diagnostics (list, incident open) | 6 |
| Source control | 4 |
| Keybindings | 4 |
| Report an issue | 5 |
| Archive & data | 7 |
| Entry and exit | 7 |

82 images, about 28 MB.

## Rerun

The capture test is skipped unless `INERTIA_SETTINGS_EVIDENCE_DIR` is set; the
directory is resolved from the working directory. From the repository root:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci
npm run build:bundle
INERTIA_SETTINGS_EVIDENCE_DIR=docs/pr-evidence/settings/after \
  npx playwright test tests/e2e/settings-evidence.spec.ts --max-failures=1
```

Without the variable the spec still runs its quick check that Settings fits a
760 × 600 window without page overflow.
