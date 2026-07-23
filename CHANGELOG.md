# Changelog

The useful changes in each Inertia release, in plain language.

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
