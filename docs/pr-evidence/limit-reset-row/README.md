# Usage-limit row

Platform: macOS 27.0.1, Electron at device scale 2. Spec: `tests/e2e/limit-reset-appearance.spec.ts` with the fake Codex fixture and synthetic chats seeded through `RuntimeStore`; the clock is fixed. Sizes: wide 1440x920, narrow 1000x800, 760x600.

## What changed

- The row is now a tab that rises from the top edge of the composer dock, inset by `--composer-drawer-inset` like the checkout drawer under the dock, instead of a full-width zone inside the dock's frame.
- It has its own quiet warning tone (8% `--warning` over `--composer-surface`, a 28% warning hairline, no bottom edge), so it reads as the chat's status rather than part of the message input or the transcript.
- Title and reset time sit on one line with the actions at the end; the actions wrap under the title only when the dock is too narrow.
- Actions are compact plain buttons with a quiet tinted fill. Labels, roles, focus order and states are unchanged.
- The row stays inside `section.composer` in the DOM. When it is present the dock lays out as a one-column grid and the dock frame (`.composer-surface`) starts on the second row, so the frame begins under the tab. `expectComposerEndsAtDock` is unchanged; the spec also asserts that the tab is attached to the frame's top edge and narrower than it.
- After Resume now replaces the missed actions, focus moves to Cancel resume instead of falling to the page.

## Offer

| Size | Before | After |
| --- | --- | --- |
| dark-wide | ![](before-limit-reset-offer-dark-wide.png) | ![](limit-reset-offer-dark-wide.png) |
| light-wide | ![](before-limit-reset-offer-light-wide.png) | ![](limit-reset-offer-light-wide.png) |
| light-narrow | ![](before-limit-reset-offer-light-narrow.png) | ![](limit-reset-offer-light-narrow.png) |
| dark-narrow | ![](before-limit-reset-offer-dark-narrow.png) | ![](limit-reset-offer-dark-narrow.png) |
| dark-760x600 | ![](before-limit-reset-offer-dark-760x600.png) | ![](limit-reset-offer-dark-760x600.png) |

## Scheduled

| Size | Before | After |
| --- | --- | --- |
| dark-wide | ![](before-limit-reset-scheduled-dark-wide.png) | ![](limit-reset-scheduled-dark-wide.png) |
| light-wide | ![](before-limit-reset-scheduled-light-wide.png) | ![](limit-reset-scheduled-light-wide.png) |
| light-narrow | ![](before-limit-reset-scheduled-light-narrow.png) | ![](limit-reset-scheduled-light-narrow.png) |
| dark-narrow | ![](before-limit-reset-scheduled-dark-narrow.png) | ![](limit-reset-scheduled-dark-narrow.png) |
| dark-760x600 | ![](before-limit-reset-scheduled-dark-760x600.png) | ![](limit-reset-scheduled-dark-760x600.png) |

## Scheduled and snoozed

| Size | Before | After |
| --- | --- | --- |
| dark-wide | ![](before-limit-reset-snoozed-dark-wide.png) | ![](limit-reset-snoozed-dark-wide.png) |
| light-wide | ![](before-limit-reset-snoozed-light-wide.png) | ![](limit-reset-snoozed-light-wide.png) |
| light-narrow | ![](before-limit-reset-snoozed-light-narrow.png) | ![](limit-reset-snoozed-light-narrow.png) |
| dark-narrow | ![](before-limit-reset-snoozed-dark-narrow.png) | ![](limit-reset-snoozed-dark-narrow.png) |
| dark-760x600 | ![](before-limit-reset-snoozed-dark-760x600.png) | ![](limit-reset-snoozed-dark-760x600.png) |

## Blocked

| Size | Before | After |
| --- | --- | --- |
| dark-wide | ![](before-limit-reset-blocked-dark-wide.png) | ![](limit-reset-blocked-dark-wide.png) |
| light-wide | ![](before-limit-reset-blocked-light-wide.png) | ![](limit-reset-blocked-light-wide.png) |
| light-narrow | ![](before-limit-reset-blocked-light-narrow.png) | ![](limit-reset-blocked-light-narrow.png) |
| dark-narrow | ![](before-limit-reset-blocked-dark-narrow.png) | ![](limit-reset-blocked-dark-narrow.png) |
| dark-760x600 | ![](before-limit-reset-blocked-dark-760x600.png) | ![](limit-reset-blocked-dark-760x600.png) |

## Missed

| Size | Before | After |
| --- | --- | --- |
| dark-wide | ![](before-limit-reset-missed-dark-wide.png) | ![](limit-reset-missed-dark-wide.png) |
| light-wide | ![](before-limit-reset-missed-light-wide.png) | ![](limit-reset-missed-light-wide.png) |
| light-narrow | ![](before-limit-reset-missed-light-narrow.png) | ![](limit-reset-missed-light-narrow.png) |
| dark-narrow | ![](before-limit-reset-missed-dark-narrow.png) | ![](limit-reset-missed-dark-narrow.png) |
| dark-760x600 | ![](before-limit-reset-missed-dark-760x600.png) | ![](limit-reset-missed-dark-760x600.png) |

## Rejected action

| Size | Before | After |
| --- | --- | --- |
| dark-wide | ![](before-limit-reset-error-dark-wide.png) | ![](limit-reset-error-dark-wide.png) |
| light-wide | ![](before-limit-reset-error-light-wide.png) | ![](limit-reset-error-light-wide.png) |
