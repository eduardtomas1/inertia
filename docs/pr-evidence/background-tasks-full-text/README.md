# Background tasks: full text on the running line

Captured from `tests/e2e/background-tasks.spec.ts` on Linux (Xvfb) with the
same seeded fixture. The "Code reviewer" task reports both a progress sentence
("Reading the provider adapters") and its last tool ("Grep").

Before, the running line showed only the bare tool name, so the sweep moved
across a single word. Now the line shows the provider's progress sentence and
the same `turn-thinking-sweep` moves across all of it. A descriptive activity
such as "Searching src/server for usage parsers" (Codex) still wins over the
progress text, and a bare tool name is still shown when it is all the provider
sent. The reduced-motion, forced-colours and hidden-window guards are
unchanged.

Each image stacks four frames of the same card, taken about 0.7 s apart with
animations running.

| Before | After |
| --- | --- |
| ![Before: only "Grep" sweeps](before-running-line-frames-dark.png) | ![After: the whole sentence sweeps](after-running-line-frames-dark.png) |

The full panel after the change, with animations disabled:
[after-background-tasks-claude-wide-dark](after-background-tasks-claude-wide-dark.png).
