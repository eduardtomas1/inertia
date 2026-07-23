# Changelog

The useful changes in each Inertia release, in plain language.

## 0.0.5 — 2026-07-23

### A clearer review workspace

- Changes now opens into a richer diff-review flow with better file navigation, review summaries, and safer commit workflows.
- Responses render polished Markdown, while tool work, reasoning, approvals, and questions stay together in a chronological activity center.
- The composer, project sidebar, usage display, request cards, and theme behavior have been refined across desktop sizes.

### Stronger providers and desktop foundations

- Provider interactions are more reliable across Codex, Claude, Cursor, and OpenCode, with better lifecycle handling and Windows Codex discovery.
- Project identity, runtime diagnostics, database state, terminal behavior, and recovery information are clearer and more resilient.
- Application icons were rebuilt, and Linux identity checks, Electron security validation, and packaged-app smoke coverage were strengthened across all three platforms.

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
