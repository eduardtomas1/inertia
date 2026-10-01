# Review changes against the request

The Changes panel accepts an editable review brief with links to user messages.
Review suggestions map changed hunks to those requirements, identify requirements
with no visible evidence, and surface unconnected changes under **Needs
explanation**. A finding becomes an editable request added to the next prompt.
Confidence and the limits of diff-only evidence remain visible: a test change
does not mean tests ran or passed.

## Screenshots

These are Chromium captures of the production `ChangesPanel` and lazy-loaded
`ScopeReviewPanel`, with the real app styles and deterministic synthetic props.
The viewport is 1440 × 1100. A separate 620 × 920 check found no horizontal
overflow or renderer errors. The fixture supplies the parsed diffs and review
results; these captures do not establish Electron, IPC, provider, or native
runtime correctness.

1. [Request beside mapped changes](request-and-mapped-changes.png): retry handling
   and its test map to their requirements; cancellation has no visible evidence.
2. [Unexpected change and editable request](unexpected-change-request.png): an
   authentication change is highlighted beside its diff, with a drafted request.
3. [Review after correction](refreshed-review-after-correction.png): the fixture
   removes the authentication edit and supplies the refreshed result. The
   cancellation evidence gap remains visible.

The native scenario in `tests/e2e/scope-review.spec.ts` exercises the complete
brief-save → isolated provider-boundary review → request draft → actual file
correction → refreshed review flow. It captures the same three states and checks
narrow-window geometry. Its deterministic provider fixture does not contact a
live model.

## Validation

- 214 focused tests pass across summary validation, persistence, concurrent
  edits, renderer behavior, migration lineage, database upgrades and recovery.
- `npm run check:quality` passes, including all TypeScript projects.
- `npm run build:bundle --ignore-scripts` and the bundle budgets pass. The
  ignored lifecycle hook is the unavailable native guardian build; the normal
  production bundling and budget commands execute. See [measurements](bundle.json).
- The complete `npm run check` was attempted but stops at `pretest`: this
  environment lacks `/usr/bin/musl-gcc`. Electron's headless launch also failed,
  so native E2E validation is pending GitHub Actions. The browser captures above
  are not a substitute for that gate.

Review briefs use append-only schema 86. Source links must reference this chat's
user messages, input and output remain bounded, stale brief/diff results are
discarded, and concurrent windows receive detail invalidations. Existing legacy
summaries remain readable. No dependency or provider protocol changes.
