# Changelog

The useful changes in each Inertia release, in plain language.

## Next

## 0.0.14 — 2026-07-29

### Two agent perspectives from one prompt

- A lightning action beside New chat configures exactly two independently named chats from one shared prompt, with a separate project, provider route, reasoning level, and access mode for each side.
- Duo reuses Inertia's real model chooser, readiness checks, conversation creation, and split-workspace ownership. Cross-project pairs keep independent files, Git review, terminals, plans, previews, approvals, questions, drafts, and provider sessions.
- An optional bounded default Duo stores only safe chat names and route identity. It never copies prompts, projects, credentials, provider options, or secrets, and warns when both agents will edit the same checkout.
- Partial creation and ambiguous delivery stay honest: an acknowledged survivor can continue, duplicate submission is blocked, and uncertain delivery requires an authoritative refresh instead of risking duplicate chats.

### Drafts and daily workspace flow

- Adding a project now opens a recoverable unpersisted draft immediately. Sidebar search shows only matching active conversations, long pasted requests can collapse without losing scroll position, and IME composition can no longer send accidentally.
- A bounded prompt stash keeps up to 12 unfinished text prompts with their exact safe route identity for later use in either split pane. Attachments and credentials deliberately remain outside the stash.
- Project-file references in answers open directly in Files. Supported text files can be edited in a focused dialog that verifies the content has not changed before saving.
- Expanded folders survive refresh when still present, nested repository changes remain scoped to their real repository, and workspace tools stay owned by the exact chat that requested them.

### Truthful goals, skills, and delegated agents

- Codex-native goals and Inertia-local objectives are persistent, separately attributed, reconnect-safe, and never injected or relabeled as one another.
- Codex and Claude skills are discovered through the selected route, attached only to the next turn, revalidated at the privileged execution boundary, and represented without exposing provider paths, contents, or credentials.
- Compact Codex and Claude subagent trees preserve provider-reported parentage, status, continuation, and terminal state. Guide parent prepares an ordinary parent follow-up; direct Stop appears only for supported live Claude tasks.
- Provider plans no longer open the Plan tab automatically. Goal and skill state remains independent across split chats, themes, narrow layouts, and keyboard navigation.

### Faster long conversations

- Conversation virtualization now considers estimated render weight, so activity-heavy histories no longer wait for a fixed 40-turn threshold. The reproduced 36-turn, 1,224-activity fixture mounts fewer than 24 timeline rows.
- Closed historical tool output and run details are unmounted instead of merely hidden. Large command payloads return only when their disclosure is opened.
- Streaming commentary uses a lightweight text path and a measured 240 ms persistence/projection cadence, then settles into full safe Markdown. A deterministic 100,000-character stream reduced persistence flushes from 98 to 7 without losing content.
- Stream updates persist before projection, batch message and conversation state transactionally, and flush at lifecycle and hydration boundaries so restart recovery and two-renderer exact-once delivery remain authoritative.
- A reproducible loopback WebSocket compression benchmark is now documented. `permessage-deflate` remains disabled until repeated cross-platform evidence shows that reduced snapshot bytes outweigh the CPU and memory cost.

### Clearer contrast and state

- Light and dark themes now share semantic contrast, border, selection, focus, disabled, and status-surface tokens across the transcript, composer, activity, sidebars, settings, model chooser, split workspaces, diffs, attachments, and notifications.
- Secondary text and boundaries are more readable without turning the interface into stacked panels. Hover, selection, focus, approvals, questions, warnings, failures, and success states remain distinguishable through text and shape as well as colour.
- Numeric WCAG regression coverage and refreshed original-resolution screenshots protect the intended contrast across interface scales and response densities.

### Reliability across providers, files, and Git

- Conversation-bound sends, imports, pickers, draft restoration, previews, Stop actions, provider callbacks, and delayed responses now retain exact ownership across rapid A → B → A navigation and cross-project split use.
- Git reversal is serialized per canonical repository, workspace traversal pins directory identities, and malformed, duplicated, empty, oversized, or unrepresentable provider interactions fail closed.
- OpenCode startup, authentication, requests, interactions, and cancellation are bounded per run. Codex App Server, Cursor ACP, one-shot CLI, maintenance, Git, and supervised-runtime process trees must be confirmed stopped before a terminal success or cancellation can settle; Claude SDK tasks use bounded interrupt/abort acknowledgement.
- Interrupted runtime projections reconcile atomically, packaged shutdown waits for runtime and attachment cleanup, and Windows process-tree handling uses explicit system executables and observable confirmation instead of trusting a launched kill command.

### Security and release confidence

- Filesystem and Git commands carry short-lived, owner- and purpose-bound secure-file authorities. Main revalidates containment, inode, mode, and digest at the operation boundary, while replacement journals preserve crash-safe recovery.
- Attachments remain opaque, privately stored, inode-pinned, content-verified, bounded, and lifecycle-owned. Native previews use isolated sessions and suspend before trusted overlays paint.
- Provider output, approvals, goals, skills, subagents, credentials, runtime capabilities, and diagnostics preserve their existing least-authority and redaction boundaries. Full Access remains the only explicit opt-in transfer of unrestricted provider authority.
- The final release candidate is gated by architecture and lint checks, four TypeScript projects, unit and integration tests, portable provider contracts, Electron E2E, production dependency audit, three-OS packaging, package smoke, Electron fuse verification, checksums, and provenance.

## 0.0.13 — 2026-07-28

### Two chats, two complete workspaces

- Any second chat can open beside the current one, even when it belongs to another project. Each pane keeps its own draft, provider route, transcript, files, Git review, changed-file context, terminal sessions, plan, preview, and actions.
- Split chats can be resized side by side or stacked in a narrow window. Promoting a chat changes only its visual position, preserving both conversations' terminals, previews, attachments, drafts, and provider context.
- Workspace tools move below each split chat so both projects retain usable height. Each pane remembers its own selected tool and size, while terminals stay alive after their first activation as the user moves between Changes, Files, Plan, and Preview.
- Conversation detail subscriptions, pending approvals and questions, delayed Git/files/review responses, reversible Undo handles, activity actions, and native preview requests now carry explicit pane ownership so closing or switching one project cannot lose its controls or replace or navigate the other.

### A useful workspace summary without permanent tool weight

- A compact Environment summary is the default workspace surface, bringing the current project, Git branch and changes, active work, delegated agents, and recent context into one calm disclosure.
- Files, Changes, Terminal, Plan, and Preview remain one click away but start compacted on a fresh install. Settings can restore the previous tools-first startup for users who prefer it.
- Activity now groups only the latest meaningful provider operations beneath the owning agent run, keeps manual source-control work independent, and leaves the complete bounded history available on demand.
- Provider-reported five-hour and weekly limits can notify at 25%, 15%, and 5% remaining. Notifications are route-scoped, deduplicated, freshness-aware, and remain silent when a provider does not report an authoritative quota.

### Attachments and previews that behave like desktop tools

- Pasted and selected images open in a larger accessible preview before sending, while PDFs have an embedded preview plus an explicit external fallback for Linux environments without a usable Chromium PDF viewer.
- Every pending attachment can still be removed individually. Clipboard MIME recovery, opaque attachment capabilities, digest verification, bounded reads, cleanup, and provider input ownership remain enforced.
- Two native project previews can run independently at once. Navigation, history, bounds, redirects, downloads, permissions, modal occlusion, conversation changes, and shutdown are now brokered by owner and conversation context.
- Closing Inertia destroys native previews before the supervised runtime settles, preserving live terminal sessions during normal use without delaying application shutdown.

### Release confidence

- The release candidate passes architecture checks, standard and type-aware lint, four TypeScript projects, 1,154 unit and integration tests, 114 portable provider tests, 37 Electron end-to-end scenarios, packaged-app smoke, Electron fuse verification, strict macOS bundle verification, and the production dependency audit.
- Cross-platform coverage includes wide and stacked split chats, different project roots, independent terminal IDs and working directories, dual native previews, attachment modal ownership, compact startup, quota thresholds, activity grouping, reconnect sequencing, and accessible focus restoration.

## 0.0.12 — 2026-07-28

### Faster evidence that a change is safe

- Renderer interaction tests now run in a real lightweight DOM, covering command-palette focus, filtering, selection and reset, global-shortcut ownership, delayed terminal focus, and disclosure lifecycles without waiting for a packaged desktop run.
- The Electron end-to-end gate keeps all 35 platform-level scenarios while splitting the former 5,552-line release spec into independently seeded feature suites for the shell, settings, workspace, palette, review, terminal, activity, layout, and transcript.
- Linux CI now measures every TypeScript source file—including files no test imports—and enforces conservative global and renderer coverage floors. macOS, Windows, and Linux continue to run the ordinary unit and packaged-app gates.
- Type-aware promise checks now catch floating, misused, and incorrectly awaited promises alongside the existing React hook and correctness rules.

### Guardrails that shape the repository

- Architecture validation now parses the complete source import graph—including dynamic imports with import attributes—resolves TypeScript aliases and runtime `.js` specifiers, rejects cycles and invalid layer direction, and derives compatibility-facade boundaries from structure instead of a growing path list.
- The runtime process protocol now lives in the shared Node layer used by Electron main and the supervised utility runtime, removing the last server-to-main dependency.
- Uniform source, test-case, and test-support ceilings replace hand-maintained per-file budgets, so a failing guardrail cannot be satisfied by appending another exception.
- Test TypeScript projects now cover the complete unit and Electron suites without hand-enumerating whichever renderer components a test happens to import.

### More predictable onboarding and provider maintenance

- Node.js 22 is declared for contributors, provider-facing SDK versions are exact, Dependabot handles routine dependency and GitHub Actions updates, and a secret-free weekly canary checks the latest Codex, product-shaped Claude configuration, Cursor, ACP, and OpenCode surfaces before provider drift reaches a release.
- The repository now includes private security-reporting guidance, privacy-aware bug and pull-request templates, a concise coding-agent guide, and a troubleshooting path built around Inertia's sanitized runtime diagnostic report.
- Package builds generate deterministic production-dependency notices and include Inertia, Electron, and Chromium license material with every desktop artifact.
- English-only interface dates, clocks, compact numbers, and quota reset labels now use one explicit locale instead of mixing English and operating-system formatting in the same view.

## 0.0.11 — 2026-07-28

### A foundation that is easier to change safely

- Codex App Server execution and backend-profile management now live in bounded protocol, event, configuration, lifecycle, discovery, and runtime modules instead of growing inside two giant files.
- The workspace scene, global shortcuts, update flow, review matching, runtime diagnostics, and provider controls have clearer ownership and smaller renderer update surfaces.
- Architecture checks now enforce production file and import ceilings, persistence cycle boundaries, React hook rules, and lint coverage for tests as part of the normal check.
- Database migrations use validated SQL identifiers, Git failure classification is locale-independent, and compatibility facades remain thin enough to preserve the existing V0.0.10 workflow and history.

### Large and rootless workspaces feel first-class

- Projects without a root Git repository can discover nested module repositories beyond the old 64-repository cutoff, report the true bounded result, and choose how many repositories to display.
- Nested repositories keep their own review marks, notes, questions, selective reverts, stale-target reconciliation, and repository identity throughout the review flow.
- Large repositories load a selected file's diff directly while still validating its fingerprint against the complete repository state; nested review marks can no longer satisfy a root commit warning accidentally.
- Automatic checkpoints preserve sparse-checkout boundaries, ignored files, staged index content, exact working-tree bytes, and unusual paths without running repository clean/smudge filters or reference hooks.

### Calmer cross-platform work

- Windows transcript spacing and model-selection geometry, Linux streaming-caret placement and readability, composer breathing room, and narrow layouts received another platform-specific pass.
- Settled transcript rows keep stable identities, background work animation pauses when the window is inactive, and tool activity remains smooth during long or rapidly updating runs.
- Supported provider CLI updates and Inertia release notices remain visible through reconnects without duplicating an operation or installing anything silently.
- Full Access is documented as the provider-level safety bypass it is, including Codex's unrestricted sandbox/approval configuration and Claude's permission-skipping mode.

### Security and release confidence

- Automatic Git inspection disables repository-controlled filesystem monitors, external diff drivers, text conversion, executable filters, and hooks while preserving ordinary explicit Git workflows.
- Embedded previews accept only literal loopback origins; remote HTTPS links open externally, and attachment previews revalidate ownership, containment, type, size, and content digest before returning exact bytes.
- Signing credentials are scoped only to their matching release runner, support reports retain their newest bounded diagnostics, and local security reports remain outside the repository.
- The final release candidate passed architecture checks, lint, typecheck, 1,070 unit and integration tests, 114 portable provider tests, 35 Electron end-to-end tests, production dependency audit, native package smoke, Electron fuse verification, and macOS bundle verification across macOS arm64, Windows x64, and Linux x64.

## 0.0.10 — 2026-07-27

### A stronger foundation without changing the workflow

- Inertia's largest renderer, runtime, database, Git, transcript, composer, provider, and shared-contract files are now split into focused modules with clear ownership.
- Compatibility boundaries preserve the behavior and stored history from 0.0.9 while making individual features easier to understand, test, and change safely.
- New architecture checks catch oversized core files, dependency cycles, misplaced command ownership, and accidental imports through compatibility facades before they reach a release.
- Persistence migrations and repositories now live in explicit domains, keeping projects, conversations, turns, usage, Git artifacts, reviews, provider metadata, settings, and recovery state independently testable.

### Smoother daily work across every platform

- Model Favorites now save the useful route as one preset—including harness, backend, model, and reasoning—while the chooser opens directly on those choices instead of an unnecessary All view.
- Provider setup can detect supported CLI updates, explain the official update route, run it inside Inertia, show bounded progress, and keep the operation available after a renderer reconnect.
- Windows transcript spacing, model-row hover geometry, first-message readiness, Linux readability, composer breathing room, and narrow-layout behavior received a focused cross-platform pass.
- Tool activity keeps its restrained workstream presentation with lower-cost animation and more stable scroll anchoring during long or rapidly updating runs.
- Initial Git refresh failures are now reported instead of leaving an unexplained empty Changes view, and recursive Files refreshes no longer retain stale nested folders.

### Safer attachments and more reliable lifecycles

- Pasted and selected attachments now cross the renderer boundary as opaque capabilities rather than arbitrary paths. The runtime independently verifies the app-owned location, identity, type, size, and content digest before a provider can use them.
- Attachment ownership follows renderer, runtime, retry, cancellation, restart, and shutdown lifecycles so removed or orphaned files cannot silently escape the retained-storage limit.
- Provider completion settles and reaches the interface before optional Git capture or attachment cleanup, so Stop and working states disappear when the provider actually finishes.
- Active provider updates survive reconnects, rejected submissions keep safe retry ownership, and interrupted runtime cleanup remains conservative until process exit is confirmed.

### Release confidence

- Architecture checks, linting, typecheck, 1,002 unit tests, 113 portable provider tests, 35 Electron end-to-end tests, packaged-app smoke tests, Electron fuse verification, dependency auditing, and strict macOS bundle verification protect the release.
- Linux x64, Windows x64, and macOS arm64 continue to build from the exact release tag with checksums and build-provenance attestations.

## 0.0.9 — 2026-07-27

### A minimal workstream instead of stacked chat panels

- The conversation now reads like a calm engineering document: a lightly tinted request, chronological agent commentary, compact operational activity, a clean final answer, and quiet supporting details.
- Commentary continues to break tool activity into its real sequences. Adjacent calls can fold together without reordering work or hiding failures, warnings, approvals, or provider questions.
- Successful historical turns no longer repeat a prominent `Worked for…` row above every answer. Status, duration, copy, and run details settle into the answer footer while important exceptional work remains visible.
- Raw command output and large diagnostics stay inside bounded execution details instead of taking over the primary transcript. Interrupted transport work is distinguished from a genuine provider or tool failure.
- Active work uses a restrained motion-aware wash, while completed history remains static and reduced-motion preferences are respected.

### One composer, faster model and context choices

- The composer is now one cohesive bottom dock with the multiline prompt, attachments, model, reasoning, access, mode, context, and Send or Stop controls sharing one restrained surface.
- The selected model opens an anchored searchable palette with provider and harness filters, favorites, keyboard navigation, compatibility explanations, and truthful backend identity.
- Incompatible harness, backend, endpoint, or configuration changes still require a clearly explained new chat, so a provider session is never presented as transferred between routes.
- Context and usage now live behind one compact circular control. The popover separates context occupancy, processed tokens, quotas, reset timing, freshness, and unavailable provider data without borrowing limits from another backend.
- Pasted or uploaded images and documents receive secure previews before sending and can be removed individually. Validation, bounded reads, project-path rules, and cleanup remain enforced.

### Real projects, repositories, and delegated work

- Files can be explored recursively with lazy folder loading, project-wide search, keyboard tree navigation, safe previews, and refreshes that invalidate stale nested listings.
- Changes discovers bounded nested Git repositories, groups their modified files by real repository identity, and keeps the review surface compact when workspace tools are narrow.
- Expected non-Git workspaces no longer receive noisy turn-artifact warnings, while partial, expired, truncated, or genuinely failed history remains honest.
- Project rows include a quick New chat action without restoring the repetitive sidebar entry points removed in earlier releases.
- Claude delegation and provider subagent activity remain connected to the parent turn. Follow-up messages stay inside the authoritative active turn, and supported usage information continues to update without implying that context transfers between agents.

### Faster settlement and stronger heavy-run recovery

- A turn stops appearing active as soon as its provider reaches a terminal result. Git artifact capture can finish separately without leaving Stop or the working animation on screen.
- Build mode now encourages direct, action-biased execution while preserving investigation, approvals, sandboxing, recovery, and Plan mode.
- Codex App Server transport accepts safely bounded larger protocol messages, keeps aggregate output limits, classifies process and protocol interruptions, and retains sanitized technical details for diagnosis.
- Cross-platform coverage now exercises the complete Minimal Workstream, composer, model chooser, context control, attachments, delegated agents, recursive files, nested Git repositories, transport cleanup, responsive layouts, accessibility, packaging, Electron fuses, and native app smoke.

## 0.0.8 — 2026-07-26

### A conversation that follows the work

- Provider commentary and tool activity now appear in the order they actually happened, so the transcript can show an update, the calls it led to, the next update, and the final answer as one understandable sequence.
- Only adjacent calls are grouped. Commentary naturally separates one stretch of work from the next, while failed, cancelled, waiting, or important actions stay visible.
- Streaming prose remains visibly in progress and is promoted to the final answer only when the turn settles, preventing an early update from being mistaken for the completed response.
- Completed work folds into a lighter elapsed-time and action summary without turning the conversation into a stack of panels.
- Requests, approvals, provider questions, plans, reasoning summaries, execution details, checkpoints, and Git artifacts keep their established place in the turn.

### Calmer at every transcript size

- Long conversations use more accurate virtual row estimates for Markdown, code, tables, activity groups, narrow layouts, and expanded details.
- Scroll anchoring, jump-to-latest behavior, keyboard turn navigation, reduced-motion preferences, and live-region announcements remain stable while streamed content changes height.
- Responsive coverage now validates wide, stacked, and compact workspaces as well as long transcripts, streaming answers, grouped activity, settled work, motion preferences, and accessible labels.
- The main workspace, light theme, search palette, and README screenshots received a fresh visual validation pass.

### Release confidence

- The complete typecheck, unit, provider protocol, end-to-end, packaged-app, Electron-fuse, and macOS signature checks run against the release candidate.
- A repository-wide threat model and framework-specific security review found no critical or high-severity implementation defect. Security reports remain outside the repository.
- Production dependencies audit clean. A transitive advisory remains limited to the build-only packaging toolchain while the project waits for a compatible upstream fix rather than forcing an unsafe downgrade or override.

## 0.0.7 — 2026-07-26

### Trustworthy history for every agent request

- Every request now has a durable turn record with its original agent harness, model backend, model, lifecycle, and terminal result instead of reconstructing identity from the latest conversation state.
- Read-only answers about selected diff lines stay beside the matching hunk with their exact backend and model attribution instead of becoming ordinary conversation history.
- Legacy and interrupted work is recovered honestly. Missing attribution or incomplete repository history remains visibly unavailable or partial rather than being guessed.
- In Git workspaces, Inertia records before-and-after repository snapshots for each turn and stores a bounded, content-addressed patch. Historical changes can be opened and compared after later edits or a restart without reading the current working tree as if it were the past.
- Repository and worktree identity are checked across capture. Truncated patches, missing snapshots, moved worktrees, and failed captures preserve their real completeness state.
- Conversation lists now load authoritative lightweight metadata separately from heavier message, activity, plan, checkpoint, and Git-artifact detail. Stale detail responses cannot replace the conversation currently being viewed.
- Runtime mutations carry an ordered sequence cursor. Reconnects replay only committed updates after that cursor, while generation changes fall back to a complete snapshot without duplicating work.
- Stable transcript rows and incremental projection keep histories with hundreds of turns and thousands of messages responsive, including after runtime restart and recovery.

### Explicit model backends without hidden context transfer

- Agent harness, model backend, and model selection are now separate parts of one authoritative execution route. Native providers continue to use their own backend unless an explicitly compatible profile is selected.
- Settings can create, validate, probe, enable, disable, and choose custom backend profiles with explicit endpoints, authentication, model catalogs, context windows, and Claude tier routing.
- Plain HTTP is rejected except for exact loopback development endpoints. Unsafe URLs, malformed models, incompatible harness and protocol pairs, stale probes, and ambiguous defaults are rejected before launch.
- Custom backend credentials are encrypted through macOS Keychain, Windows DPAPI, or Linux Secret Service and never stored in the application database. Credential generations prevent a replaced or deleted secret from being confused with an earlier execution route.
- The built-in Kimi coding profile runs only through the verified Claude harness route and accepts only its supported endpoint, model IDs, and documented context choices.
- Existing conversations retain their original route even if a profile is edited or removed. Supported model changes on the same backend may continue in place; changing harnesses, backends, endpoint identity, configuration revision, or credential generation requires a clearly separated new chat.
- Backend launch environments are scoped per run so concurrent native and custom sessions do not inherit one another's endpoints, models, or credentials.

### Restart, migration, and release confidence

- Database migrations now preserve authoritative turns, execution identity, runtime sequencing, backend profiles, and historical Git artifacts while retaining the full fixture chain from earlier releases.
- SQLite write failures do not consume sequence numbers or expose partial runtime mutations, and credential failures stay contained to the affected backend.
- Coverage now includes long-history projection, restart and replay, turn-artifact persistence, profile deletion history, credential isolation, route boundaries, custom Codex backends, Kimi through Claude, and concurrent backend launch isolation.
- Cross-platform contracts continue to validate Windows Codex discovery, Linux package identity and resources, hardened Electron fuses, packaged-app startup, and exact-tag release assets without adding another agent provider or changing application identity.

## 0.0.6 — 2026-07-23

### A clearer way into every project

- Fresh installs now open directly on the project picker instead of creating an example project and conversation.
- Each project has one consistent New chat entry point. The empty project view explains the next step without repeating the same action throughout the sidebar.
- Project navigation now separates Projects from Work: Projects keeps the repository tree calm, while Work prioritizes conversations that need attention, active runs, and a bounded recent history.
- Completed background work, unread results, settled threads, archived conversations, and failures are easier to distinguish without leaving permanent noise behind.
- Search, keyboard navigation, focus handling, and compact drawer behavior remain predictable across both navigation modes.

### Agent work that is easier to follow

- Live reasoning and tool activity now read as one compact provider run, followed by a clearly separated final answer.
- Completed activity can fold into a quiet summary while failed, cancelled, waiting, or important work remains visible.
- The Runs surface prioritizes approvals and provider questions before active and recent work, with only the actions each run can actually perform.
- Conversations keep the provider they started with after the first message. Switching to a different agent now requires a new chat so provider-owned context is never implied to transfer.
- Usage presentation responds more carefully to the available space and to whether the provider has supplied a meaningful report.

### Smoother desktop behavior

- Windows and macOS resolve the saved or system theme before the first visible paint, reducing mismatched background flashes while the renderer starts.
- Native window backgrounds use only validated cached theme values and safely fall back when that cache is missing or invalid.
- Sidebar transitions, titlebar spacing, composer controls, panel boundaries, and agent transcript density received another responsive pass.
- End-to-end coverage now starts from a genuinely empty installation and exercises project creation, Projects and Work navigation, prioritized runs, theme bootstrap, and common workspace sizes.
- The cross-platform suite also verifies Windows Codex discovery through safe Unicode npm shims and keeps timing-sensitive macOS layout checks isolated from later tests.

## 0.0.5 — 2026-07-23

### Review changes with confidence

- Changes is now a complete review workspace with per-file navigation, insertion and deletion totals, line wrapping, whitespace filtering, and a layout that remains usable in narrow side panels.
- Select one line or a range and ask a read-only question, request a focused revision, save a local note, or add the exact selection to the next prompt.
- Review questions always run in a fresh read-only agent turn, even when the main conversation is in Build mode with Full Access.
- Selected revisions create a recovery checkpoint first and clearly explain that the selection is the requested focus rather than an unsafe promise that surrounding code can never be touched.
- Selective revert now handles staged, unstaged, and mixed changes without discarding unrelated work. It revalidates the complete diff, file, hunk, selected lines, and both Git layers before writing.
- Every selective revert creates an immediate recovery backup and offers Undo. Undo refuses to overwrite later file or index changes.
- Line endings, final newlines, executable permissions, and the distinction between staged and working-tree content are preserved.
- Conflicts, renamed or deleted files, untracked files, symbolic-link type changes, binary content, stale selections, and truncated diffs are rejected honestly when a safe line-level reversal cannot be guaranteed.
- Agent-generated change summaries cover every current file and hunk in an isolated, tool-free review session. Compact hints flag visible behavior, regression, security, migration, test, performance, or documentation concerns without presenting them as established facts.
- Review summaries are discarded if the diff changes while they are running. Oversized, incomplete, duplicated, malformed, or timed-out results are never saved.
- Files and hunks can be marked reviewed, filtered by review state, and navigated with Previous and Next controls. Review progress persists across restarts and becomes stale when its target changes.
- Local notes can be attached to a file, hunk, or selected lines, edited later, returned to the prompt, or used to request a revision. Changed targets keep their note but mark it stale.
- The commit dialog can stage and commit only checked paths, preserves unrelated staged work, and warns when selected hunks have not been reviewed.

### Conversations that stay readable

- Assistant responses now render safe GitHub-flavored Markdown with headings, lists, task lists, links, tables, and fenced code.
- Code blocks support syntax highlighting, per-block wrapping, and one-click copy. Tables can be copied as Markdown or CSV.
- External links open outside Inertia, project-file links open through the local desktop bridge, and unsafe HTML, protocols, path traversal, and escaping file links are blocked.
- Streaming responses remain structurally stable while a code fence is still being written and switch to highlighting only when it is safe.
- Each user request, reasoning summary, tool activity, approval, question, system message, final answer, and recovery checkpoint is grouped into one chronological turn.
- Successful tool work can collapse into a quiet elapsed-time summary, while failures, cancellations, unsupported actions, and important warnings remain visible.
- The latest settled turn can show a current changed-file summary, and any answer can be copied directly.
- Transcript following no longer pulls the view away while reading older work; a Jump to latest control appears instead.
- Response density, default code wrapping, completed-work collapsing, changed-file summaries, timestamps, and live thinking visibility now persist as preferences.

### Activity-first projects and workspace control

- A new Activity Center groups agents, checks, services, and source-control work with live elapsed time and clear running, waiting, completed, stopped, and failed states.
- Waiting work distinguishes an approval from a provider question. Supported actions include opening the thread, folder, terminal, or service preview, plus stop, retry, rerun, failure details, and dismiss.
- Activity survives restarts, while interrupted runs are recovered without pretending their old processes are still stoppable.
- Project navigation now offers Classic and Activity-first modes. Active, waiting, failed, completed, unread, settled, and archived work remain visually distinct.
- Completed background work gains an unread marker until visited. Finished threads can be settled into history, restored to active work, archived, renamed, or deleted when safe.
- Projects are grouped using canonical Git identity and repository-relative paths rather than matching display names. Repository, repository-plus-folder, and separate grouping modes are available globally and per project.
- Search and keyboard navigation work across the new project and activity models, including wrapping arrow navigation and Home/End movement.
- Turn checkpoints can restore the project to its state before that request after active work has stopped.

### Provider behavior, usage, and setup

- Approvals, questions, plans, cancellation, activity, and failure handling now share one provider-neutral contract while retaining each provider's real capabilities.
- Codex, Claude, Cursor, and OpenCode interactions update existing lifecycle records instead of producing duplicate activity rows.
- A provider known to be unavailable is rejected before a user turn is persisted, then refreshed so the visible setup state remains accurate.
- Provider authentication runs in an owned terminal and refreshes installation, account, model, and capability state when it exits.
- Windows Codex discovery now checks official standalone installs, custom Codex locations, npm, pnpm, Bun, Volta, PATH, and `where.exe`, validates candidates, and selects a working executable.
- Windows command shims support Unicode paths, spaces, and parentheses without enabling generic shell execution or treating arguments as command text. A manually selected Codex executable always takes precedence.
- Settings show the selected Codex executable, allow a validated manual override, and report installation, sign-in, and App Server support separately.
- Usage can be expanded, compact, or hidden. Context occupancy, provider-defined processed-token totals, quota windows, reset timing, freshness, and cached provenance remain distinct.
- Missing or zero context limits, unavailable quotas, stale refreshes, and out-of-range provider values are shown honestly instead of producing invented capacity or misleading meters.

### Desktop polish, privacy, and release reliability

- The composer gained cleaner cascading menus for project actions, providers, models, reasoning, mode, and access. Menus dismiss on outside click or Escape without forcing a selection.
- Selected diff context and image attachments remain visible before sending, with clear removal controls and enforcement of the real message-size limit.
- Interface scale now supports Compact, Default, Comfortable, and Large across navigation, messages, controls, files, and diffs, independently from terminal text size.
- The visible Light/Dark quick toggle, System theme behavior, panel boundaries, narrow layouts, send-button containment, request cards, commit-dialog focus, and macOS titlebar branding received another responsive pass.
- Local runtime diagnostics record only bounded lifecycle and failure metadata. Prompts, source, token values, credentials, capabilities, and raw local paths are excluded or redacted.
- Diagnostic files use private permissions, rotate at 256 KB, expire after seven days, and can be revealed from Settings without affecting app startup if logging fails.
- The app preserves canonical project identity, review state, notes, response preferences, activity, provider sessions, streamed answers, plans, reasoning, usage, and metadata through database migrations and restarts.
- Application icons now come from one deterministic vector mark with complete platform sizes. Linux packages validate desktop identity, icons, scaling behavior, and the bundled runtime resource.
- CI and exact-tag releases exercise macOS arm64, Windows x64, and Linux x64 with locked installs, typechecks, unit and provider protocol suites, Electron end-to-end tests, dependency auditing, native packaging, hardened Electron fuse checks, and packaged-app smoke tests.
- Release publication revalidates the exact tag, verifies platform assets, preserves the complete macOS signature, normalizes the Windows installer name, publishes checksums without replacing existing files, and records build provenance attestations.

## 0.0.4 — 2026-07-22

### First-class provider runtimes

- Codex conversations now use the versioned app-server protocol in every access mode instead of falling back to the legacy CLI path.
- Claude, Cursor, and OpenCode now run through their native SDK or ACP integrations, with provider-owned sessions, streaming, approvals, questions, plans, reasoning, usage, attachments, model choices, and cancellation when supported.
- Provider-specific capabilities are explicit, so an unavailable feature is reported honestly instead of being silently emulated by another runtime.
- Usage accounting now preserves each provider's real scope: context occupancy, run totals, session totals, or thread totals are no longer presented as interchangeable values.

### A resilient local runtime

- Database, terminal, WebSocket, and provider work now live in a supervised Electron utility process instead of the main process.
- If that runtime crashes, Inertia keeps the window open, rotates its local connection capability, recovers interrupted work safely, and reconnects without duplicating a live worker.
- App shutdown now gives active providers time to cancel, escalates boundedly when a worker is unresponsive, and finishes through Electron's normal quit lifecycle.
- Native modules remain outside ASAR where required, while hardened Electron fuses and complete-bundle signature checks remain enforced for packaged builds.

### Metadata, interface, and release reliability

- Models, reasoning options, account limits, provider versions, and authentication state now refresh through a correlated persistent cache without presenting stale values as live.
- Usage controls stay out of the way until a provider has actually reported usage or quota data.
- Composer menus now dismiss on outside click or Escape, restore focus predictably, and preserve the current choice until a new one is selected.
- Global shortcuts now remain available while the terminal is focused, including Command Palette on Windows and Linux.
- Command Palette actions now resolve against the latest typed query, even when Enter follows input immediately on a slower desktop.
- Permission prompts now present clean native filesystem paths on Windows instead of mixed path separators.
- The frameless macOS titlebar now carries a larger, compact Inertia mark with deliberate clearance from the native window controls.
- CI now exercises Linux x64, Windows x64, and macOS arm64 with portable provider fixtures, Electron E2E coverage, dependency audits, native package smoke tests, signature and fuse checks, and exact non-clobbering release assets with attestations.

## 0.0.3 — 2026-07-22

### A more aware agent workspace

- Model and reasoning choices now come from the connected provider instead of a fixed list.
- Codex thinking summaries can appear live and remain with the conversation after a restart.
- The composer shows remaining context and account usage, including reset timing when the provider reports it.
- Provider usage is refreshed after each run so the display does not quietly go stale.

### More room to work

- Command search now covers actions, projects, and threads with full keyboard navigation.
- The project sidebar and workspace tools can both collapse, reopen, and remember their state.
- Existing panel resizers remain available, with clearer but restrained visual boundaries.
- Wide, stacked, and compact layouts received another overlap and navigation pass.

### Settings and reliability

- Settings now have focused sections for general preferences, providers, source control, keybindings, and local data.
- New controls cover thinking summaries, usage visibility, plan behavior, destructive-action confirmation, and conversation defaults.
- Provider reasoning, usage, and settings state now survive restarts through the local database.
- Desktop tests now cover search, panel persistence, settings navigation, resizers, tool tabs, previews, and multiple window sizes.
- macOS community packages now receive complete-bundle ad-hoc signing after Electron security fuses are applied, preventing an invalid-signature launch failure.

## 0.0.2 — 2026-07-22

- Connected the workspace to real local coding-agent accounts, beginning with the Codex app-server flow.
- Added streaming conversations, resumable sessions, plans, approvals, agent questions, and persistent conversation state.
- Added provider setup, resizable workspace panels, restrained glass styling, and light, dark, and system themes.
- Published native downloads for macOS, Windows, and Linux.

## 0.0.1 — 2026-07-22

- Established Inertia's Electron workspace, project navigation, conversation layout, Git tools, file browser, preview, and terminal foundation.
