# Chats without a project

T3 Code reference inspected: [`c57a04b722f2172e3be2c8f73c936d10b4582431`](https://github.com/pingdotgg/t3code/blob/c57a04b722f2172e3be2c8f73c936d10b4582431/apps/server/src/ws.ts#L1778). Its implementation expands the screenshot's `~/.t3` comment to `<T3 base directory>/scratch/<date>-<words>-<thread id>`, lazily creates a “No project” container, and gives each thread its own plain folder. The corresponding selector is `DraftHeroHeadline.tsx`, with asynchronous preparation in `useScratchProject.ts`.

Inertia retains its required project foreign key, workspace path receipts and native process boundary. Migration 86 identifies one managed scratch container. Its location is `<Inertia runtime data directory>/scratch` (the existing `INERTIA_DATA_DIR` override still applies). A date/title/full-UUID child folder is created when a chat materializes. No Git repository is initialized; the worktree preference does not turn these folders into Git worktrees. Deleting a chat retains its files.

Only the privileged runtime chooses paths. The ensure command accepts no fields. Folder receipts must remain valid across restarts; replacing the root or a chat folder cannot silently renew authority. A data directory inside a Git repository is refused, including inherited checkouts. Root-only workspace operations are refused so a draft cannot read or execute in the shared scratch container.

The empty profile, command palette and new-chat selector expose “Start without a project” / “No project”. The existing composer survives a project change. An asynchronous response cannot pull the user back after navigating away. Materialized chats display “Chat folder”, without worktree or detached-HEAD labels.

## Visual evidence

The four PNGs are unedited Electron captures from `tests/e2e/scratch-appearance.spec.ts`, using an existing-chat fixture and the actual renderer, runtime and persisted folder records. The scenario passes on Linux under Xvfb and checks both appearances, selector deduplication and narrow-window overflow. These screenshots do not claim provider execution was verified on this host.

## Validation

- Focused navigation, draft ownership, keyboard selector, workspace receipts and runtime RPC coverage passes. The RPC integration uses real Git and SQLite, including an inherited-checkout rejection.
- Migration upgrade and append-only lineage coverage passes; released migration fingerprints remain unchanged.
- `npm run check:quality` passes (architecture, migration lineage, generated themes, lint and all TypeScript projects).
- Production renderer compilation and bundle ceilings pass. `renderer-bundle.json` records the exact delta from main `2364d768a71214bfbff7481bb5545cf19906a78f`, with identical dependencies and unchanged prior headroom.
- Full suite: pending final result below.
- `scratch-chat.spec.ts` retains the complete empty-profile → first send → separate second folder → restart scenario with a deterministic provider fixture. This host cannot complete it: `/proc/self/task/<pid>/children` does not exist, and the unchanged native Linux guardian exits 70 before admitting Git. The runtime fails closed at `linux-readiness`. No guardian check or provider path has been bypassed. macOS/Windows and live provider accounts were not exercised locally.
