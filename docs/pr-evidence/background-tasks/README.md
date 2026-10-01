# Background tasks

Real screenshots of the built Electron app on macOS 27.0.1 (arm64), captured by
`tests/e2e/background-tasks.spec.ts` with `animations: "disabled"`. The spec seeds
an isolated synthetic database through `RuntimeStore.upsertSubagentTrace` and
`RuntimeStore.createWorkspaceRun`. No live profile, credentials, provider CLI,
private prompt or user repository content is used.

## Fixture

| Chat | Harness | What it shows |
| --- | --- | --- |
| Usage pipeline refactor | `codex-app-server` | Live root with model, current activity, cumulative tokens, latest-step breakdown and context window; live nested child; failed task with provider state; completed task; a running dev server and a failed test command |
| Claude delegated review | `claude-agent-sdk` | Live task with the last tool as its activity and a cumulative total only; completed task with provider-reported runtime |
| OpenCode schema sweep | `opencode-sdk` | Live task with the full latest-step breakdown, including cache writes; finished nested child |
| Cursor thread summary | `cursor-acp` | Completed task with model and runtime; tokens labelled "Cursor does not report tokens for delegated tasks" |
| Kimi quick fix | `kimi-acp` | Empty state: "Kimi Code does not report delegated agents. Commands it starts appear here." |

## Wide (1440 × 1100)

| Dark | Light |
| --- | --- |
| ![Wide dark](background-tasks-wide-dark.png) | ![Wide light](background-tasks-wide-light.png) |

## Narrow (1000 × 800), Details open

| Light | Dark |
| --- | --- |
| ![Narrow light](background-tasks-narrow-light.png) | ![Narrow dark](background-tasks-narrow-dark.png) |

## Each harness

![Claude](background-tasks-claude-wide-dark.png)
![OpenCode](background-tasks-opencode-wide-dark.png)
![Cursor](background-tasks-cursor-wide-dark.png)

## What the spec asserts

- Summary and token-total lines, the running badge on the tab and on the corner
  toggle, Active/Finished grouping, tree indentation of a nested child, status
  text pills, model chips, provider icons and per-row elapsed and token cells.
- Details: cumulative total, the "Latest step" breakdown, the context meter,
  tool uses, runtime and route; Claude shows a total without a breakdown.
- The Commands section and its existing Dismiss command (`activity.dismiss`).
- Keyboard: the Details control is reached with Tab from the tab and toggled
  with Enter; every button in the region has an accessible name.
- No viewport overflow, no horizontal overflow in the panel, and the composer
  still ends at its dock, at both window sizes.
- After an application restart the surface is still selected, reported tokens
  persist, and the runtime's recovery marks the live tasks Lost and the running
  command Failed.

## Runs on this machine

- `tests/e2e/background-tasks.spec.ts --repeat-each=3`: 9 passed normally and
  9 passed under 12 CPU-burning processes.
- `activity`, `layout`, `composer-entry`, `terminal` and `draft-worktree` specs:
  each passed once after the rename.

## Not exercised

- Linux and Windows rendering, forced-colours mode and reduced motion in a real
  window (covered by stylesheet assertions in the DOM tests only).
- Stopping a delegated task or a command from the panel against a real
  process: seeded runs have no owned process, so Stop is not offered; the Stop
  wiring is covered by DOM tests.
- Live telemetry from real providers; all data is seeded.

See [renderer-bundle.json](renderer-bundle.json) for every closure measured
against `origin/main` (`2364d768`) and the feature base (`70d3d0f8`).
