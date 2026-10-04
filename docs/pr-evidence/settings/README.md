# Settings rework evidence

Before and after screenshots for the Settings rework PR. The before set is
main at `1053edf2` ([before/README.md](before/README.md)); the after set is
the rework branch at `12e3ed5c` ([after/README.md](after/README.md)).
Both come from `tests/e2e/settings-evidence.spec.ts` on macOS at device scale
2 with the same synthetic fixture.

## Changes and their pairs

Each row is one change, the before and after images that show it, and the PR
body section where the pair is embedded. "New" marks a surface that did not
exist before.

| Change | Before | After | PR body section |
| --- | --- | --- | --- |
| General opened with Restore defaults and a hero header; Appearance now opens on plain theme rows | [general-appearance-p1-light-wide](before/general-appearance-p1-light-wide.png) | [appearance-theme-light-wide](after/appearance-theme-light-wide.png) | Summary |
| Twelve sections become nine, with a search field above them | [entry-opened-light-wide](before/entry-opened-light-wide.png) | [entry-opened-light-wide](after/entry-opened-light-wide.png) | Structure |
| A switch now says Saved in its own row | [general-workspace-p1-light-wide](before/general-workspace-p1-light-wide.png) | [chats-saved-light-wide](after/chats-saved-light-wide.png) | Saving and feedback |
| An invalid spend limit is shown in its row after blur, coloured as an error | [projects-spend-limit-invalid-light-wide](before/projects-spend-limit-invalid-light-wide.png) | [projects-spend-limit-invalid-light-wide](after/projects-spend-limit-invalid-light-wide.png) | Saving and feedback |
| The repository URL is validated on blur instead of saved per keystroke | [discord-invalid-url-light-wide](before/discord-invalid-url-light-wide.png) | [devices-discord-invalid-url-light-wide](after/devices-discord-invalid-url-light-wide.png) | Saving and feedback |
| Posting without a repository URL shows the error in the Discord row | [discord-default-light-wide](before/discord-default-light-wide.png) | [devices-discord-error-light-wide](after/devices-discord-error-light-wide.png) | Saving and feedback |
| Escape now leaves Settings | [exit-escape-light-wide](before/exit-escape-light-wide.png) | [exit-escape-light-wide](after/exit-escape-light-wide.png) | Settings as a mode |
| Leaving through Workspace returns to the chat | [exit-workspace-light-wide](before/exit-workspace-light-wide.png) | [exit-workspace-light-wide](after/exit-workspace-light-wide.png) | Settings as a mode |
| Reopening lands on the last section instead of General | [exit-reopened-light-wide](before/exit-reopened-light-wide.png) | [exit-reopened-light-wide](after/exit-reopened-light-wide.png) | Settings as a mode |
| ⌘, closes Settings | New | [exit-shortcut-light-wide](after/exit-shortcut-light-wide.png) | Settings as a mode |
| ⌘, reopens the last section | New | [entry-shortcut-light-wide](after/entry-shortcut-light-wide.png) | Settings as a mode |
| Search in Settings lists matching rows under their section | [entry-opened-light-wide](before/entry-opened-light-wide.png) | [search-results-light-wide](after/search-results-light-wide.png) | Search in Settings and in the palette |
| Arrow keys move through search results | New | [search-result-focused-light-wide](after/search-result-focused-light-wide.png) | Search in Settings and in the palette |
| Enter opens the row and focuses its control | New | [search-opened-light-wide](after/search-opened-light-wide.png) | Search in Settings and in the palette |
| No settings match | New | [search-no-results-light-wide](after/search-no-results-light-wide.png) | Search in Settings and in the palette |
| Search at 1000 × 800 | New | [search-results-dark-narrow](after/search-results-dark-narrow.png) | Search in Settings and in the palette |
| Typing theme in the palette finds the Mode row instead of nothing | [entry-palette-theme-light-wide](before/entry-palette-theme-light-wide.png) | [entry-palette-theme-light-wide](after/entry-palette-theme-light-wide.png) | Search in Settings and in the palette |
| Open settings is listed once, with settings rows below | [entry-palette-settings-light-wide](before/entry-palette-settings-light-wide.png) | [entry-palette-settings-light-wide](after/entry-palette-settings-light-wide.png) | Search in Settings and in the palette |
| Choosing it opens Appearance at the Mode row | New | [entry-palette-theme-opened-light-wide](after/entry-palette-theme-opened-light-wide.png) | Search in Settings and in the palette |
| Notifications get their own section: background-only, quota warnings, Play sound, Show mascot and Animate mascot on one screen | [general-notifications-light-wide](before/general-notifications-light-wide.png) | [notifications-alerts-light-wide](after/notifications-alerts-light-wide.png) | New settings |
| Default access per project, with the caution line for Full access | [projects-project-p2-light-wide](before/projects-project-p2-light-wide.png) | [projects-default-access-saved-light-wide](after/projects-default-access-saved-light-wide.png) | New settings |
| Repository display limit under the project's Advanced disclosure | [projects-project-p3-light-wide](before/projects-project-p3-light-wide.png) | [projects-advanced-light-wide](after/projects-advanced-light-wide.png) | New settings |
| New-chat defaults move from Providers › Advanced to Chats › New chats | [providers-advanced-light-wide](before/providers-advanced-light-wide.png) | [chats-new-chats-light-wide](after/chats-new-chats-light-wide.png) | New-chat defaults and the provider fallback |
| The duplicate backend defaults go; the Model row explains the provider fallback | [model-backends-profile-p2-light-wide](before/model-backends-profile-p2-light-wide.png) | [chats-new-chats-fallback-light-wide](after/chats-new-chats-fallback-light-wide.png) | New-chat defaults and the provider fallback |
| Posting to Discord asks for confirmation first | [discord-default-light-wide](before/discord-default-light-wide.png) | [devices-discord-post-confirm-light-wide](after/devices-discord-post-confirm-light-wide.png) | Discord |
| Archived chats move below the data controls, with a filter and pages of 20 | [archive-default-p1-light-wide](before/archive-default-p1-light-wide.png) | [data-archived-p1-light-wide](after/data-archived-p1-light-wide.png) | Archived chats, Restore defaults and runtime messages |
| Filtering archived chats | New | [data-archived-filter-light-wide](after/data-archived-filter-light-wide.png) | Archived chats, Restore defaults and runtime messages |
| After Show N more, focus on the first new chat | New | [data-archived-all-light-wide](after/data-archived-all-light-wide.png) | Archived chats, Restore defaults and runtime messages |
| Restore defaults moves to the end of Data and states its scope | [general-appearance-p1-light-wide](before/general-appearance-p1-light-wide.png) | [data-defaults-light-wide](after/data-defaults-light-wide.png) | Archived chats, Restore defaults and runtime messages |
| Restore defaults asks inline, with Cancel focused | New | [data-restore-confirm-light-wide](after/data-restore-confirm-light-wide.png) | Archived chats, Restore defaults and runtime messages |
| Scale, text density and the working indicator as plain rows | [general-appearance-p2-light-wide](before/general-appearance-p2-light-wide.png) | [appearance-scale-light-wide](after/appearance-scale-light-wide.png) | Appearance |
| Appearance in dark | [general-appearance-dark-wide](before/general-appearance-dark-wide.png) | [appearance-theme-dark-wide](after/appearance-theme-dark-wide.png) | Appearance |
| Appearance at 760 × 600 | [general-appearance-dark-760x600](before/general-appearance-dark-760x600.png) | [appearance-theme-dark-760x600](after/appearance-theme-dark-760x600.png) | Appearance |
| Agent responses become the Transcript group | [general-responses-light-wide](before/general-responses-light-wide.png) | [chats-transcript-light-wide](after/chats-transcript-light-wide.png) | Chats |
| Source control becomes Review and terminal in Chats | [source-control-default-light-wide](before/source-control-default-light-wide.png) | [chats-transcript-light-wide](after/chats-transcript-light-wide.png) | Chats |
| Chats in dark | [general-workspace-dark-wide](before/general-workspace-dark-wide.png) | [chats-new-chats-dark-wide](after/chats-new-chats-dark-wide.png) | Chats |
| Review and terminal in dark | [source-control-default-dark-wide](before/source-control-default-dark-wide.png) | [chats-transcript-dark-wide](after/chats-transcript-dark-wide.png) | Chats |
| Chats at 1000 × 800 | [source-control-default-dark-narrow](before/source-control-default-dark-narrow.png) | [chats-new-chats-dark-narrow](after/chats-new-chats-dark-narrow.png) | Chats |
| Notifications in dark | [general-notifications-dark-wide](before/general-notifications-dark-wide.png) | [notifications-alerts-dark-wide](after/notifications-alerts-dark-wide.png) | Notifications |
| Notifications at 1000 × 800, with the sprite guide collapsed | [general-workspace-p2-light-wide](before/general-workspace-p2-light-wide.png) | [notifications-alerts-dark-narrow](after/notifications-alerts-dark-narrow.png) | Notifications |
| Switch states stay distinguishable in forced colours | New | [notifications-alerts-forced-colours-light-wide](after/notifications-alerts-forced-colours-light-wide.png) | Notifications |
| Keyboard with the fixed Open settings row and the snapshot shortcut | [keybindings-default-light-wide](before/keybindings-default-light-wide.png) | [keyboard-default-light-wide](after/keyboard-default-light-wide.png) | Keyboard |
| Keyboard at 760 × 600 | [keybindings-default-dark-760x600](before/keybindings-default-dark-760x600.png) | [keyboard-default-dark-760x600](after/keyboard-default-dark-760x600.png) | Keyboard |
| All projects with grouping and compact sidebar | [projects-all-light-wide](before/projects-all-light-wide.png) | [projects-all-light-wide](after/projects-all-light-wide.png) | Projects |
| Project rows without the bordered card | [projects-project-p1-light-wide](before/projects-project-p1-light-wide.png) | [projects-project-p1-light-wide](after/projects-project-p1-light-wide.png) | Projects |
| The Add action form | [projects-add-action-light-wide](before/projects-add-action-light-wide.png) | [projects-add-action-light-wide](after/projects-add-action-light-wide.png) | Projects |
| Projects at 1000 × 800 | [projects-all-dark-narrow](before/projects-all-dark-narrow.png) | [projects-all-dark-narrow](after/projects-all-dark-narrow.png) | Projects |
| Providers and custom backends in one Agents section, status once | [providers-codex-p1-light-wide](before/providers-codex-p1-light-wide.png) | [agents-codex-light-wide](after/agents-codex-light-wide.png) | Agents |
| Capability details behind a quiet Details disclosure | [providers-codex-p2-light-wide](before/providers-codex-p2-light-wide.png) | [agents-codex-details-light-wide](after/agents-codex-details-light-wide.png) | Agents |
| A signed-out provider | [providers-claude-signed-out-light-wide](before/providers-claude-signed-out-light-wide.png) | [agents-claude-signed-out-light-wide](after/agents-claude-signed-out-light-wide.png) | Agents |
| A provider whose CLI is not installed; Provider updates says No updates available. | [providers-cli-missing-light-wide](before/providers-cli-missing-light-wide.png) | [agents-cli-missing-light-wide](after/agents-cli-missing-light-wide.png) | Agents |
| Custom backends as rows, without eyebrow, pills or dot-only status | [model-backends-profile-p1-light-wide](before/model-backends-profile-p1-light-wide.png) | [agents-custom-backends-light-wide](after/agents-custom-backends-light-wide.png) | Agents |
| The profile editor on the same recipe | [model-backends-new-profile-p1-light-wide](before/model-backends-new-profile-p1-light-wide.png) | [agents-new-profile-light-wide](after/agents-new-profile-light-wide.png) | Agents |
| Agents at 760 × 600 | [providers-codex-dark-760x600](before/providers-codex-dark-760x600.png) | [agents-codex-dark-760x600](after/agents-codex-dark-760x600.png) | Agents |
| Private Connect with real icons and collapsed diagnostics | [connections-default-light-wide](before/connections-default-light-wide.png) | [devices-private-connect-light-wide](after/devices-private-connect-light-wide.png) | Devices & integrations |
| Snapshots and Discord in Devices & integrations | [snapshots-default-light-wide](before/snapshots-default-light-wide.png) | [devices-snapshots-light-wide](after/devices-snapshots-light-wide.png) | Devices & integrations |
| Devices & integrations at 1000 × 800 | [connections-default-dark-narrow](before/connections-default-dark-narrow.png) | [devices-private-connect-dark-narrow](after/devices-private-connect-dark-narrow.png) | Devices & integrations |
| Storage as one line per fact | [archive-default-p2-light-wide](before/archive-default-p2-light-wide.png) | [data-storage-light-wide](after/data-storage-light-wide.png) | Data |
| Export and import | [archive-default-p3-light-wide](before/archive-default-p3-light-wide.png) | [data-recovery-light-wide](after/data-recovery-light-wide.png) | Data |
| Data in dark | [archive-local-data-dark-wide](before/archive-local-data-dark-wide.png) | [data-storage-dark-wide](after/data-storage-dark-wide.png) | Data |
| Data at 760 × 600 | [archive-default-dark-760x600](before/archive-default-dark-760x600.png) | [data-storage-dark-760x600](after/data-storage-dark-760x600.png) | Data |
| Report an issue without the two unrelated cards | [report-issue-default-p1-light-wide](before/report-issue-default-p1-light-wide.png) | [help-report-issue-light-wide](after/help-report-issue-light-wide.png) | Help |
| Diagnostics without the hero | [diagnostics-list-light-wide](before/diagnostics-list-light-wide.png) | [help-diagnostics-light-wide](after/help-diagnostics-light-wide.png) | Help |
| An open incident | [diagnostics-incident-p1-light-wide](before/diagnostics-incident-p1-light-wide.png) | [help-diagnostics-incident-light-wide](after/help-diagnostics-incident-light-wide.png) | Help |
| Support and About and updates in Help | [general-responses-dark-wide](before/general-responses-dark-wide.png) | [help-support-dark-wide](after/help-support-dark-wide.png) | Help |
| Diagnostics filters in a disclosure at 1000 × 800 | [diagnostics-list-dark-narrow](before/diagnostics-list-dark-narrow.png) | [help-diagnostics-dark-narrow](after/help-diagnostics-dark-narrow.png) | Help |

## Other images

The remaining after images complete the coverage (dark wide, dark narrow and
760 × 600 for each section). Each sits next to its closest before image; the
old General section had no narrow or 760 × 600 image per group.

| Before | After |
| --- | --- |
| [providers-codex-dark-narrow](before/providers-codex-dark-narrow.png) | [agents-codex-dark-narrow](after/agents-codex-dark-narrow.png) |
| [providers-codex-dark-wide](before/providers-codex-dark-wide.png) | [agents-codex-dark-wide](after/agents-codex-dark-wide.png) |
| [general-appearance-dark-wide](before/general-appearance-dark-wide.png) | [appearance-scale-dark-wide](after/appearance-scale-dark-wide.png) |
| [general-appearance-dark-narrow](before/general-appearance-dark-narrow.png) | [appearance-theme-dark-narrow](after/appearance-theme-dark-narrow.png) |
| [source-control-default-dark-760x600](before/source-control-default-dark-760x600.png) | [chats-new-chats-dark-760x600](after/chats-new-chats-dark-760x600.png) |
| [archive-default-dark-wide](before/archive-default-dark-wide.png) | [data-archived-dark-wide](after/data-archived-dark-wide.png) |
| [archive-default-p2-light-wide](before/archive-default-p2-light-wide.png) | [data-archived-p2-light-wide](after/data-archived-p2-light-wide.png) |
| [archive-default-dark-wide](before/archive-default-dark-wide.png) | [data-defaults-dark-wide](after/data-defaults-dark-wide.png) |
| [archive-local-data-dark-wide](before/archive-local-data-dark-wide.png) | [data-recovery-dark-wide](after/data-recovery-dark-wide.png) |
| [archive-default-dark-narrow](before/archive-default-dark-narrow.png) | [data-storage-dark-narrow](after/data-storage-dark-narrow.png) |
| [connections-default-dark-760x600](before/connections-default-dark-760x600.png) | [devices-private-connect-dark-760x600](after/devices-private-connect-dark-760x600.png) |
| [connections-default-dark-wide](before/connections-default-dark-wide.png) | [devices-private-connect-dark-wide](after/devices-private-connect-dark-wide.png) |
| [snapshots-default-dark-wide](before/snapshots-default-dark-wide.png) | [devices-snapshots-dark-wide](after/devices-snapshots-dark-wide.png) |
| [entry-chat-light-wide](before/entry-chat-light-wide.png) | [entry-chat-light-wide](after/entry-chat-light-wide.png) |
| [diagnostics-list-dark-760x600](before/diagnostics-list-dark-760x600.png) | [help-diagnostics-dark-760x600](after/help-diagnostics-dark-760x600.png) |
| [diagnostics-list-dark-wide](before/diagnostics-list-dark-wide.png) | [help-diagnostics-dark-wide](after/help-diagnostics-dark-wide.png) |
| [report-issue-default-dark-760x600](before/report-issue-default-dark-760x600.png) | [help-report-issue-dark-760x600](after/help-report-issue-dark-760x600.png) |
| [report-issue-default-dark-narrow](before/report-issue-default-dark-narrow.png) | [help-report-issue-dark-narrow](after/help-report-issue-dark-narrow.png) |
| [report-issue-default-dark-wide](before/report-issue-default-dark-wide.png) | [help-report-issue-dark-wide](after/help-report-issue-dark-wide.png) |
| [general-responses-light-wide](before/general-responses-light-wide.png) | [help-support-light-wide](after/help-support-light-wide.png) |
| [keybindings-default-dark-narrow](before/keybindings-default-dark-narrow.png) | [keyboard-default-dark-narrow](after/keyboard-default-dark-narrow.png) |
| [keybindings-default-dark-wide](before/keybindings-default-dark-wide.png) | [keyboard-default-dark-wide](after/keyboard-default-dark-wide.png) |
| None (General had one image per size, for its first card) | [notifications-alerts-dark-760x600](after/notifications-alerts-dark-760x600.png) |
| [projects-all-dark-760x600](before/projects-all-dark-760x600.png) | [projects-all-dark-760x600](after/projects-all-dark-760x600.png) |
| [projects-all-dark-wide](before/projects-all-dark-wide.png) | [projects-all-dark-wide](after/projects-all-dark-wide.png) |
| [projects-project-p2-light-wide](before/projects-project-p2-light-wide.png) | [projects-project-p2-light-wide](after/projects-project-p2-light-wide.png) |
