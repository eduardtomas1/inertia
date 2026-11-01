# Thread feel visual pass, before and after

Captures for the visual pass on `feat/visual-thread-feel`. `before/` is main at ce0767c9, the base the branch is rebased on; `after/` is produced from the branch with the same command and the same harness. Both sets come from one permanent Playwright spec, `tests/e2e/visual-evidence.spec.ts`, run against each worktree's built bundle with the same seeded projects, chats and turns, fake providers only and no DOM edits, so the build is the only difference.

A pair is the same file name in both folders: `before/<surface>-<theme>-<width>x<height>.png` and `after/<surface>-<theme>-<width>x<height>.png`, with theme `light` or `dark`.

## Producing a set

After `npm run build:bundle` in the worktree being captured:

```sh
node scripts/visual-evidence.mjs --out docs/screenshots/visual-t3-2026-10/after --replace
```

- `--out` is the folder for the PNG files. The runner stops if `out/` is missing and asks for `npm run build:bundle`.
- `--replace` deletes the PNG files this run would write; without it the runner refuses to overwrite.
- `--surfaces a,b` captures only the named surfaces (for example `--surfaces model-chooser,toast`) and leaves the other files alone.
- The runner sets `INERTIA_VISUAL_EVIDENCE_DIR` (and `INERTIA_VISUAL_EVIDENCE_SURFACES`) and runs the spec in the `isolated` Playwright project with one worker. Without `INERTIA_VISUAL_EVIDENCE_DIR` the spec is skipped, so ordinary E2E runs never launch it.

To regenerate `before/` from a new base commit, use a separate worktree of that commit, never the branch:

1. Give it the branch worktree's dependencies through a junction (`cmd /c mklink /J <base>\node_modules <branch>\node_modules`) when the lockfiles match, or run `npm ci` there.
2. Copy `tests/e2e/visual-evidence.spec.ts`, `tests/e2e/support/visual-evidence-fixture.ts` and `scripts/visual-evidence.mjs` into it as untracked files.
3. Run `npm run build:bundle`, then `node scripts/visual-evidence.mjs --out <branch>/docs/screenshots/visual-t3-2026-10/before --replace`.
4. Delete the copied files, `out/`, `test-results/` and `resources/generated/runtime-process-guardian/`, restore `resources/generated/windows-runtime-job-integrity.json` (the build rewrites it), remove the junction with `cmd /c rmdir`, and check that `git status` is clean.

## How the captures are made

- One Electron instance with a fresh profile and temporary data folder. Settled history is written to the runtime store before launch; the running, approval and question turns are written after the runtime starts, so startup recovery does not settle them, and the window then reloads.
- Codex is a fake app-server that lists two models and reports no rate limits; Claude is a fake CLI that reports signed out. No real credentials and no network. The pending approval and question are delivered to the renderer as provider events on the runtime socket, the same events a provider sends.
- The window is 1440×860 and every size is a Playwright-emulated viewport at device scale factor 1: 1440×920 for every surface, plus 760×600 and 1920×1200 for `composer`, `transcript-finished` and `transcript-running`. Every capture is taken in light and in dark.
- The renderer clock is fixed at 2026-10-03 10:30 UTC, so relative ages, running timers and sidebar day groups do not move between runs. Day groups and clock times follow the capturing machine's time zone.
- `prefers-reduced-motion: reduce` is emulated, so loaders and the sidebar aurora render their static frame. Each capture waits until fonts are loaded, no finite animation runs, scroll heights, popover boxes and page text are unchanged across two stable windows, and no loading or checking text is shown (provider checks, Git status, diff and file loading, message search). It is taken with animations disabled and the caret hidden.
- The pointer rests at the top-right edge of the window, outside any control, except on the hover captures; focus is cleared unless the surface is about focus (model chooser, command palette, composer menu, Commit dialog).
- The model chooser is opened three times before its capture. For it and the composer access menu, the harness alternately resizes the viewport by one pixel and back and closes and reopens the popover with the mouse until it sits where its own recorded placement says, and fails the run if it never does; on main a composer popover can otherwise keep a stale position from one measuring pass. A model chip that still shows a raw model id (while provider models refresh) also counts as unsettled, because the chip row reflows when the label returns.
- The terminal capture sets the shell prompt to `$ ` and clears the screen, so no account, host or temporary path is shown. The command palette is captured with the query `export` because its empty state lists project paths under the temporary folder.

## Seeded data

Three projects: Inertia (the fixture Git workspace on `main`, with uncommitted edits to `src/components/Button.tsx`, `sample.ts` and `docs/guide.md`), billing-service and docs-site.

| Chat | Project | State |
| --- | --- | --- |
| New chat | Inertia | Empty |
| Refine the response timeline | Inertia | Working: interim prose, a finished activity group (command, read, search), a live group with an edit and a command, two running subagents with role, description, model and progress, a running thinking strip |
| Document the export format | Inertia | Finished 9 minutes ago: long Markdown answer (H2, H3, table, code block, inline-code file paths, numbered list), activity group, two finished subagents, four changed files |
| Tighten the release checklist | Inertia | Two turns, Claude then Codex, with a context handoff |
| Run the migration verification | billing-service | Waiting for command approval |
| Choose the invoice export layout | billing-service | Waiting for an answer to a question |
| Rotate the webhook signing keys | billing-service | Failed |
| Migrate invoices to the new schema | billing-service | Three finished turns |
| Fix broken anchor links | docs-site | Finished yesterday |
| Write the theming guide | docs-site | Finished 3 days ago (Earlier) |
| Audit image alt text | docs-site | Finished 6 days ago (Earlier) |

## Surfaces

Each surface is captured as `<surface>-light-1440x920.png` and `<surface>-dark-1440x920.png`; the three marked with sizes also have `-760x600` and `-1920x1200` files in both themes. 64 files per set.

| Surface | What it shows |
| --- | --- |
| `welcome` | The empty New chat in Inertia. |
| `sidebar` | The work list with every state above and the Earlier fold, with the three-turn chat open. |
| `transcript-running` (all sizes) | The running turn: header with elapsed time and Stop, interim prose, activity groups, thinking strip, subagents. |
| `transcript-finished` (all sizes) | The finished turn scrolled to the end of its answer. |
| `transcript-finished-expanded` | The same chat with its turn fold opened and scrolled to the fold row when the build has one; on main, which has no fold, it matches `transcript-finished`. |
| `transcript-finished-hover` | The pointer on the end of the finished answer, for hover-only footers. |
| `transcript-user-hover` | The pointer on the finished turn's request bubble, scrolled into view. |
| `transcript-multi` | Three turns in one chat, scrolled to the top. |
| `transcript-failed` | The failed turn. |
| `transcript-handoff` | The Claude to Codex handoff divider between two turns. |
| `transcript-approval` | The pending command approval. |
| `transcript-question` | The pending question with two options. |
| `composer` (all sizes) | The empty composer under the finished chat. |
| `composer-filled` | Text and a PDF attachment in that composer. |
| `composer-queued` | A follow-up queued with Tab on the running chat. |
| `composer-menu` | The composer's project access menu open from the finished chat, showing the popover and the open chip. |
| `model-chooser` | The model chooser open from the finished chat. |
| `command-palette` | The command palette searching `export`. |
| `dialog-commit` | The Commit dialog open over the finished chat. |
| `panel-changes` | The Changes panel with the Button.tsx diff open. |
| `panel-files` | The Files panel with sample.ts open. |
| `panel-terminal` | The terminal docked under the finished chat. |
| `settings-appearance` | Settings, Appearance. |
| `settings-chats` | Settings, Chats. |
| `toast` | The error toast (Invalid command.) shown after answering an approval the runtime does not hold. |
| `background-tasks` | The running chat's Background tasks panel with its two agent cards. |

## Identical before captures

Some `before/` files are byte-identical on purpose, because on main two surfaces show the same screen; the branch is what tells them apart in `after/`:

- `composer` and `transcript-finished` in dark at 1440×920, 760×600 and 1920×1200: both show the finished chat with an empty composer. `transcript-finished-expanded` is also identical to them in dark, and identical to `transcript-finished` in light, because main has no fold to open.
- `sidebar` and `transcript-multi` in both themes: both show the three-turn chat scrolled to the top beside the work list.

## Known variation

Two runs of the same build match byte for byte except for a few pixels by one or two colour levels: the clipped right edge of the Settings navigation text, the Files panel refresh icon, and the ellipsis icons of the composer and narrow header, whose morphing icon can settle a frame apart. Nothing else moves between runs.

## After

`after/` is now the branch at 26a69bc8, captured with the same command; it shows both rounds. The notes in this section describe the first round (69688885 after the rebase): there, `welcome`, `settings-appearance` and `settings-chats` were unchanged, and in every other surface the sidebar, header and composer stayed as on main, with the differences in the transcript and the panels beside it. The second round, below, changes the composer, the floating layers and the brand strip on top of that.

- `transcript-running`: activity group summaries read as sentences (Ran 1 command, did 1 read and 1 other action; Ran 1 command, made 1 edit), and "2 agents working" becomes one subagent group row with both agents' marks, "2 working" and the elapsed time. The user bubble leaves room below it for its hover-only request meta, so the turn starts lower.
- `transcript-finished`: the turn's activity and subagents fold behind one "Worked for 2m 14s" row, the hover footer no longer repeats the duration, and the inline-code file paths in the answer become file chips with the file name and its folder (`package.json` shows the name only).
- `transcript-finished-expanded`: the fold is open, showing the sentence summary (Ran 1 command, made 2 edits and 2 other actions) and the subagent group row ("2 subagents · 2 done") above the answer.
- `transcript-finished-hover`: the footer shows only Run details; the duration moved to the fold row.
- `transcript-user-hover`: hovering the request shows its meta row (copy) under the bubble, and the fold row and file chips appear above and in the answer.
- `transcript-multi`: each of the three turns opens with its own "Worked for …" fold row, and the migration path in the second answer is a file chip.
- `transcript-failed`, `transcript-approval`, `transcript-question`, `transcript-handoff`, `toast`: the space reserved under the user bubble moves the rest of the turn down; the failure row, approval card, question card and handoff divider are otherwise unchanged.
- `composer`, `composer-filled`, `model-chooser`, `panel-changes`, `panel-files`, `panel-terminal`: the composer, chooser and panels are unchanged; the finished transcript beside or behind them shows the fold row and file chips.
- `composer-queued`: the queued card is unchanged; the running transcript above it shows the sentence summaries and the subagent group row.
- `command-palette`: the palette is unchanged; only the transcript behind its scrim sits at a different scroll position.
- `sidebar`: the list is unchanged; the open three-turn chat shows its fold rows.
- `background-tasks`: each agent card is titled by what the agent was asked to do, with "Agent · <name>" on the line below, instead of the agent's name alone; the transcript beside it shows the sentence summaries and the subagent group row.

## After (wave 3)

Captured at 26a69bc8 (the wave 3 commits are 2ddbe318 and 91e8f14a after the rebase onto ce0767c9). A repeat run matched byte for byte in 48 of 64 files; the other 16 differ by 1 to 18 pixels, almost all along one thin line through the composer's chip row, plus the Settings navigation edge and single pixels. The 1920×1200 sidebars matched their own 1440×920 sidebars in both runs. The `before/` set from ce0767c9 matches the earlier e2ebec2b set except for the same few-pixel noise, so main's 17 new commits change none of these surfaces. Against `before/`, every file changes except `settings-appearance` and `settings-chats`, where only the brand strip changes, and the sidebar list itself stays pixel-identical.

- Every capture at 1440 wide or more: the brand strip behind the Inertia mark now shows a sparse starfield over the existing aurora; at 760×600 the sidebar is hidden and the strip is not in the frame.
- `settings-appearance`, `settings-chats`: the starfield is the only change.
- `welcome`: the placeholder becomes "Ask anything. @ files, $ skills, / commands", and reasoning, access and work mode become separate chips, each with an icon, label and chevron, instead of one dotted line.
- `composer`, `composer-filled`, `transcript-finished` and the other finished-chat captures: the same chips, and the placeholder becomes "Follow up. @ files, $ skills, / commands". The composer itself stays solid.
- `transcript-running`, `composer-queued`, `background-tasks`, `transcript-approval`, `transcript-question`: with an empty draft on a busy chat, the send button becomes a filled red Stop disc.
- `composer-menu`: the access menu is a glass popover above the chips, and the Supervised chip shows its open state.
- `dialog-commit`: the Commit dialog is glass; the dimmed transcript shows faintly through its surface, and the Commit and Commit & push buttons sit on the glass.
- `command-palette`: the palette is glass over the dimmed transcript.
- `toast`: the toast is glass; the request bubble behind it shows through slightly.
- `model-chooser`: the chooser is unchanged; the composer under it has the new chips and placeholder.
- `panel-changes`, `panel-files`, `panel-terminal`, `sidebar`, `transcript-multi`, `transcript-handoff`, `transcript-failed`, `transcript-user-hover`, `transcript-finished-hover`, `transcript-finished-expanded`: the starfield and the composer chips and placeholder are added to the first-round changes.
