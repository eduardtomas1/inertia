# Message search

Ctrl/Cmd+K now finds literal phrases in saved user messages and canonical final
agent answers across unarchived chats. Results include a highlighted text snippet,
project, chat title and message role. Opening a result focuses its turn or final
answer, including in an existing split pane or detached window. Composer drafts
stay in their owning conversation.

## Implementation

The runtime searches the existing database through a dedicated read-only worker.
It reconstructs ordered content chunks, supports migrated turn IDs, and never
loads every conversation into the renderer. No database migration, additional
index, dependency or preload method is introduced.

Queries are 2–200 UTF-16 code units after trimming. Results are ordered newest
first and capped at 20, with snippets capped at 240 code units. Searches stop
after a two-second scan budget or 256 MiB of text, skip individual messages over
16 MiB, and report incomplete results explicitly. There are at most two workers,
one current search per connection, and a five-second outer worker timeout.
Closing the palette, changing the query, disconnecting, or shutting down cancels
obsolete work. Query text and message content are not logged.

Result navigation validates project, conversation, turn and message ownership
again before revealing the match. Detached clients cannot request global
searches, and focus notifications only reach the window owning the chat.

## Verification

- Focused unit and DOM coverage: literal punctuation and Unicode; chunked and
  canonical answers; archived and settled chats; legacy IDs; result bounds;
  cancellation and shutdown; stale responses; keyboard selection; draft-safe
  navigation; split/detached ownership; bridge validation.
- The actual emitted worker searches a synthetic 100,000-message history while
  timers and concurrent database writes remain responsive.
- `npm run check:quality`: passed (migration lineage, architecture, lint and all
  TypeScript projects).
- `npm run build:bundle`: passed, including the emitted worker, private-connect
  bundle and renderer size budgets. The measured main route is 734.8 KiB and
  core JavaScript is approximately 1,977.2 KiB; ceilings retain narrow headroom.
- Electron Playwright: all three scenarios in `tests/e2e/message-search.spec.ts`
  passed on macOS ARM64, covering unloaded historical turns, draft retention,
  split/detached focus, compact layout and a full application restart.
- Full `npm run check`: queued behind the current release verification.
- Windows, Linux and packaged installers have not been exercised locally.
  No live provider calls are needed or made by this feature.

## Actual application screenshots

These are unedited Electron screenshots produced by the feature-owned E2E test
using synthetic conversations and isolated temporary projects.

### Dark palette

![Dark palette with a highlighted message match](palette-dark.png)

### Compact light palette

![Light palette at a smaller window size](palette-light.png)

### Matching historical turn

![Keyboard focus on the matching final answer](matching-turn.png)

### Detached window

![Matching answer focused in its detached window with the draft retained](detached-match.png)
