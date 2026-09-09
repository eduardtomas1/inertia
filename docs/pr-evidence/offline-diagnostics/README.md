# Diagnostics and related UI — visual evidence

Real Electron captures from isolated Linux x64 test profiles on Xvfb. All projects,
conversations, source files and provider failures are synthetic. These are not
mockups or captures of the user's working app. No private screenshots, webhook
credentials, provider transcripts or customer projects are published here.

The corresponding [implementation and verification notes](../../APPLICATION_DIAGNOSTICS.md)
describe the storage/privacy boundaries and platform limitations. The focused
Electron scenarios regenerate these screenshots and assert the relevant
geometry/keyboard/workflow behavior, rather than merely taking pictures.

## Diagnostics: list, filtering and details

| Dark | Light |
| --- | --- |
| ![Diagnostics list, dark](diagnostics-dark.png) | ![Diagnostics list, light](diagnostics-light.png) |
| ![Incident explanation and actions, dark](diagnostics-detail-dark.png) | ![Incident explanation and actions, light](diagnostics-detail-light.png) |

Narrow Settings navigation and responsive filters:

![Diagnostics in a narrow window](diagnostics-narrow.png)

The runtime has been terminated here. The exact persisted incident is still
searchable, expandable and copyable. The same scenario verifies a real native
JSON export after shutdown (only the OS picker is substituted).

![Offline diagnostics and successful copy](diagnostics-offline.png)

## Discord: secure storage feedback and diagnostic navigation

| Dark | Light |
| --- | --- |
| ![Discord settings, dark](discord-dark.png) | ![Discord settings, light](discord-light.png) |

The isolated test has no usable system credential vault; that real unavailable
state is explained without exposing a webhook. Fetch/rejection/timeout/confirmed
delivery are deterministically tested at the real privileged execution boundary
with substituted network responses. No public Discord message is sent.

## Report an issue: aligned forms and grouped publication actions

| Dark | Light |
| --- | --- |
| ![Issue report form, dark](issue-report-dark.png) | ![Issue report form, light](issue-report-light.png) |

![Description and route selection](issue-report-describe.png)

![Saved private report chat](issue-report-chat.png)

Copy/manual continuation stay separate from the primary submission action, and
saved-progress/new-draft controls stay in their own footer. The visible focus
ring comes from a real Tab-key test. No issue was submitted.

![Reviewed issue preview and publication buttons](issue-report-preview.png)

![Issue report in a narrow window](issue-report-narrow.png)

## Files: authoritative Git status indicators

| Light | Dark |
| --- | --- |
| ![Git file indicators, light](file-git-badges.png) | ![Git file indicators, dark](file-git-badges-dark.png) |

These statuses come from a real temporary Git repository, including staged and
unstaged changes, an added Java file and an untracked file. The test also restores
a file outside Inertia and confirms that Refresh removes its badge.

## File editing: native editing with syntax colors

| Light | Dark |
| --- | --- |
| ![Native Java editor with colors, light](file-editor-light.png) | ![Native Java editor with colors, dark](file-editor-dark.png) |

The same desktop test verifies native insertion/undo, horizontal and vertical
scroll alignment with long/tabbed source, the actual saved file contents and
Cancel preserving the saved version. Oversized/unsupported text and composition
fallbacks are covered by deterministic DOM tests.
