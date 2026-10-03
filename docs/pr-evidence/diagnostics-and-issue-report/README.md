# Diagnostics and Report an issue

Captured on macOS 27 (arm64) at device scale 2 with Electron from `npm run build:bundle`, Node 22. Clock frozen at 2026-10-03T16:20:00Z in the renderer. Synthetic fixture only; GitHub CLI is a stub in the fixture's provider folder and no issue was published.

## Report an issue

Spec: `tests/e2e/issue-report.spec.ts` (`capture()` per state; the same spec asserts no viewport overflow, controls inside the shared 810 px column, no nested buttons, the primary button aligned with the fields, one baseline for the action row, and focus order). Before images come from the same states on a build of `origin/main` (1053edf2); the old flow has no signed-out state.

| State | Before | After |
| --- | --- | --- |
| Form, light, 1440×920 | ![](before-issue-report-form-light-wide.png) | ![](issue-report-form-light-wide.png) |
| Form, dark, 1440×920 | ![](before-issue-report-form-dark-wide.png) | ![](issue-report-form-dark-wide.png) |
| Form, light, 1000×800 | ![](before-issue-report-form-light-narrow.png) | ![](issue-report-form-light-narrow.png) |
| Form, dark, 1000×800 | ![](before-issue-report-form-dark-narrow.png) | ![](issue-report-form-dark-narrow.png) |
| Form, dark, 760×600 | ![](before-issue-report-form-dark-760x600.png) | ![](issue-report-form-dark-760x600.png) |
| Preview, light, 1440×920 | ![](before-issue-report-preview-light-wide.png) | ![](issue-report-preview-light-wide.png) |
| Preview, dark, 1440×920 | ![](before-issue-report-preview-dark-wide.png) | ![](issue-report-preview-dark-wide.png) |
| Preview, dark, 1000×800 | ![](before-issue-report-preview-dark-narrow.png) | ![](issue-report-preview-dark-narrow.png) |
| Preview, dark, 760×600 | | ![](issue-report-preview-dark-760x600.png) |
| GitHub CLI not signed in, dark | | ![](issue-report-signed-out-dark-wide.png) |

What changed: the page uses the shared Settings type scale and column instead of its own 20 px heading and full-width layout. The step list, privacy box, model and reasoning selects, project scope and the simulated report chat are gone with the validation run. The form is What happened, Steps to reproduce, Provider and Attach diagnostics; Preview issue shows the exact title and body in an editor with Back, Copy, Open GitHub manually and Create on GitHub. A GitHub CLI problem shows under the form when the page opens. The Storage & backups and Welcome guide cards now sit below the form.
