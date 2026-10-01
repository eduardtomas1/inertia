# Pull requests panel: UI polish evidence

Real screenshots of the built Electron app on macOS 27.0.1 (arm64) at device
scale 2, captured by `tests/e2e/pull-request-links-appearance.spec.ts` with
`animations: "disabled"`. Window sizes: wide 1440 × 920, narrow 1000 × 800 and
760 × 600 (the panel becomes a sheet). All data is synthetic: fictional `acme`
repositories saved through `RuntimeStore`, and a fake `gh` script in the
fixture's provider directory that answers reads from the same data and refuses
every mutation. No real GitHub request, credential or provider runs. The same
spec asserts the layout in each state: no viewport or panel overflow, one
scroll container, no nested buttons, no truncated titles, the composer still
ends at its dock, the stack menu stays inside the panel and below the title,
and focus returns where it came from.

The panel now follows the other right-panel surfaces (Notes, Tools, Background
tasks): the tab is the title, then one row with a muted "Linked" label, the
count, Refresh and a compact "Link pull request" button. Rows are plain list
buttons with the state icon, a wrapping title, one meta line and an inline
tabular "+184 −26". The detail is one quiet card (title, state as icon and
word, branches, diff and author, checks and review with icons that match the
result, and the stack button), followed by notices and a quiet "Unlink from
chat" link. Stack actions are notices with an icon and a state word ("Merge in
progress", "Rebase outcome unknown", "Merge failed"). The merge and rebase
review dialogs name the action and the stack, state that the result cannot be
undone from Inertia, list the affected layers, put Cancel first with focus on
it, and label the primary button with the verb and count.

| Before | After |
| --- | --- |
| ![Before: list](before-pull-requests-dark.png) | ![After: list](pull-requests-dark.png) |
| Separate toolbar with a micro count, counts stacked in a second column, titles truncated, merged/draft told apart by colour only, footer repeating the count | One label row like Tools, inline "+184 −26", wrapping titles, "Draft" / "Merged" / "Sync unavailable" as words, no footer |
| ![Before: list light](before-pull-requests-light.png) | ![After: list light](pull-requests-light.png) |
| Light | Light |
| ![Before: empty](before-pull-requests-empty-dark-wide.png) | ![After: empty](pull-requests-empty-dark-wide.png) |
| Centred icon, slogan and a second "Link a pull request" button | One muted sentence and the single toolbar action |
| ![Before: failed link](before-pull-requests-link-error-light-wide.png) | ![After: failed link](pull-requests-link-error-light-wide.png) |
| Unstyled input, icon-only cancel, error outside the form with the raw incident id | Styled field with help text, the error inside the form, Cancel then Link; the URL stays for correction |
| ![Before: detail](before-pull-requests-detail-dark-wide.png) | ![After: detail](pull-requests-detail-dark-wide.png) |
| Stack button floating right, a check mark even for failing checks, hairline boxes | One card; check and review icons follow the result; stack button under the summary |
| ![Before: stack menu](before-native-stack-light.png) | ![After: stack menu](native-stack-light.png) |
| Menu clipped the title, new z-index layer and radii | Menu opens under the stack button, uses the popover tokens, and labels the base branch |
| ![Before: merge review](before-pull-requests-merge-review-light-wide.png) | ![After: merge review](pull-requests-merge-review-light-wide.png) |
| Rendered inside the panel, so the backdrop left the sidebar uncovered; generic "Merge stack" title; extra close button | Portalled dialog; "Merge stack #43" with the repository and target; the consequence; "Merge 2 layers" |
| ![Before: blocked merge](before-pull-requests-merge-blocked-dark-wide.png) | ![After: blocked merge](pull-requests-merge-blocked-dark-wide.png) |
| Orange bullet list; the confirm button still looked available | A warning notice that says what to do; the confirm button reads as unavailable and keeps focus |
| ![Before: actions](before-pull-requests-actions-light-wide.png) | ![After: actions](pull-requests-actions-light-wide.png) |
| Whole paragraphs in warning colour, no state word, pending looked like failed | Notices with icon and state word, at the top where they matter |
| ![Before: blocked stack](before-pull-requests-actions-blocked-light-wide.png) | ![After: blocked stack](pull-requests-actions-blocked-dark-wide.png) |
| Disabled items at 0.45 opacity with no reason | Readable unavailable items with the reason under each |
| ![Before: sync error](before-pull-requests-sync-error-dark-760x600.png) | ![After: sync error](pull-requests-sync-error-dark-760x600.png) |
| Warning text with its own padding | A "Sync unavailable" notice under the card |
| ![Before: back](before-pull-requests-back-focus-dark-wide.png) | Back now returns focus to the row that was opened (asserted in the spec and in `tests/renderer/pull-requests-surface.dom.test.tsx`) |
| Focus was lost after Back | |

More states after the change:

| State | Capture |
| --- | --- |
| List, 1000 × 800 light | ![Narrow list](pull-requests-list-light-narrow.png) |
| List, 760 × 600 dark | ![List 760](pull-requests-list-dark-760x600.png) |
| Empty, 1000 × 800 light | ![Empty narrow](pull-requests-empty-light-narrow.png) |
| Link form, dark | ![Link form](pull-requests-link-form-dark-wide.png) |
| Detail, light | ![Detail light](pull-requests-detail-light-wide.png) |
| Detail, 1000 × 800 dark and light | ![Detail narrow dark](pull-request-detail-dark-narrow.png) ![Detail narrow light](pull-request-detail-light-narrow.png) |
| Stack menu, dark | ![Stack menu dark](native-stack-dark.png) |
| Merge review, dark and 760 × 600 | ![Merge dark](pull-requests-merge-review-dark-wide.png) ![Merge 760](pull-requests-merge-review-dark-760x600.png) |
| Rebase review | ![Rebase](pull-requests-rebase-review-dark-wide.png) |
| Stack actions, dark | ![Actions dark](pull-requests-actions-dark-wide.png) |
| Ember palette | ![Ember](pull-requests-actions-ember-dark-wide.png) |
