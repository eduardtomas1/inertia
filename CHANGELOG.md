# Changelog

The useful changes in each Inertia release, in plain language.

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
