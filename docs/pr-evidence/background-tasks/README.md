# Background tasks

Real screenshots of the built Electron app on macOS 27.0.1 (arm64), captured by
`tests/e2e/background-tasks.spec.ts` with `animations: "disabled"`. The spec seeds
an isolated synthetic database through `RuntimeStore.upsertSubagentTrace` and
`RuntimeStore.createWorkspaceRun`. No live profile, credentials, provider CLI,
private prompt or user repository content is used.

The panel is a plain list: a muted "Running" label, one quiet card per task
(title; kind and elapsed time; model, tokens and tool uses when reported; what
it is doing with a "View turn" link), then one collapsed "Finished" row that
counts failures in words and offers a dismiss icon for finished commands. A
card expands in place into label and value rows. The only colour is the danger
text for failed work.

## Reproducibility

Every seeded timestamp is relative to a fixed instant (2026-09-30 16:20 UTC) and
the renderer's clock is frozen there with Playwright's `page.clock.setFixedTime`
before any capture. Run start and finish times are written to the fixture
database directly because `createWorkspaceRun` stamps the wall clock. Across the
three `--repeat-each` runs the Background tasks panel matched pixel for pixel;
the remaining differences above a small threshold were in the chat column (the
animated working indicator and composer stop control are canvas drawings that
`animations: "disabled"` does not freeze) and one pixel of the corner badge.

## Fixture

| Chat | Harness | What it shows |
| --- | --- | --- |
| Usage pipeline refactor | `codex-app-server` | Running: Explorer (model, tokens, tool uses, current tool), a dev server the user started, and a child agent "from Explorer". Finished: a failed agent, a completed agent and a failed test command (2 failed). Two commands the provider ran inside its turn are correctly left out. |
| Claude delegated review | `claude-agent-sdk` | Running task with its last tool, a total-only token count and a Stop control; a finished task expanded to show its details |
| OpenCode schema sweep | `opencode-sdk` | Running task expanded with every latest-step field; a finished child "from Schema sweep" |
| Cursor thread summary | `cursor-acp` | Finished task with model and runtime and no token text on the card; Details says "Not reported by Cursor" |
| Kimi quick fix | `kimi-acp` | Empty state: "No background tasks." |

## Wide (1440 × 1100)

| Dark | Light |
| --- | --- |
| ![Wide dark](background-tasks-wide-dark.png) | ![Wide light](background-tasks-wide-light.png) |

## Narrow (1000 × 800), one card expanded

| Light | Dark |
| --- | --- |
| ![Narrow light](background-tasks-narrow-light.png) | ![Narrow dark](background-tasks-narrow-dark.png) |

## Small window (760 × 600)

![760 × 600](background-tasks-760x600-dark.png)

## Each harness

![Claude](background-tasks-claude-wide-dark.png)
![OpenCode](background-tasks-opencode-wide-dark.png)
![Cursor](background-tasks-cursor-wide-dark.png)

## What the spec asserts

- Card content per harness, the "from <parent>" line for a child agent, and no
  headings, pills or summary block in the panel.
- The same active count on the tab and the corner toggle ("3 background tasks
  active"); provider command activities inside a turn are not listed or counted.
- The Finished row ("Finished 3 · 2 failed"), its danger word, and the dismiss
  icon, which removes the finished command through the existing
  `activity.dismiss` command and disappears when nothing is dismissible.
- Details: cumulative total, latest step, context remaining (same meaning as the
  Usage surface), progress and runtime; "Not reported by Cursor" only there.
- Keyboard: a card is reached with Tab from the tab and expanded with Enter;
  every button has an accessible name and no control sits inside another.
- No viewport or panel overflow, no truncated titles at 760 × 600, and the
  composer still ends at its dock.
- After an application restart the surface is still selected, tokens persist,
  recovery marks live tasks Lost with no invented runtime, and the interrupted
  dev server shows as a failed command.

## Runs on this machine

- `tests/e2e/background-tasks.spec.ts --repeat-each=3`: 9 passed normally and
  9 passed under 12 CPU-burning processes.
- `activity`, `layout`, `composer-entry`, `terminal` and `draft-worktree` specs:
  each passed once.

## Not exercised

- Linux and Windows rendering; forced colours and reduced motion in a real
  window (covered by stylesheet assertions in the DOM tests only).
- Pressing Stop against a real provider or process; the Stop wiring and focus
  behaviour when a control disappears are covered by DOM tests.
- Live telemetry from real providers; all data is seeded.

See [renderer-bundle.json](renderer-bundle.json) for every closure measured
against `origin/main` (`2364d768`) and the feature base (`70d3d0f8`).
