# Visual campaign coverage pairs

These pairs compare the branch before and after each coverage batch of the visual campaign on `feat/turn-feel-2026-10`: before is the branch as the batch started, after is the batch result, captured by the batch's own throwaway spec with the same seeded fixture and fake providers. They are not the 1a192a1e2-to-head comparison of the parent folder, which covers the main surfaces.

One light pair at 1440×920 per surface; other sizes and dark pairs only where they show something the light pair does not. Surfaces that only exist at a narrower window, or as a native overlay, are shown at that size. Sizes are viewports emulated by Playwright at device scale factor 1.

Left out on purpose:

- The batch's split terminal capture: its shell prompt showed the capture machine's account and host name. The terminal dock pair below was re-captured with a fixture prompt instead.
- Surfaces already in the parent folder's before and after set (sidebar, finished, running, handoff and failed turns, model chooser, command palette with a search, Changes and Browser panels, Daily work, empty sidebar search).
- Pairs with no visible change, near-duplicates of a kept pair (scrolled pages, a second notice state, a submenu that did not open) and pairs whose before was still loading or whose seeded data differed.

Project paths under `/var/folders/.../T/ie-*/` are the fixture's temporary repositories, and `/opt/homebrew/Cellar/node@22/...` is the fake provider's Node executable.
Pairs added afterwards: the Fix round group compares commit af84b28ad (the branch before the final fix round) with the final head. The terminal dock, branch menu, narrow commit dialog, Settings Codex models and welcome guide pairs compare the campaign start, 1a192a1e2, with the final head; they replace batch captures that showed a private shell prompt, had no before, did not open, were still loading or had no seeded models.
In those added pairs the terminal runs zsh with a fixture home folder whose prompt is `$ `, the usage error is produced by answering the usage request with an error at the test transport, the loading page is a fixture route that answers after 45 seconds, and the sidebar row actions show through keyboard focus because a hovered row could not be captured reliably.
The restart confirmation and composer More tools after captures come from the final branch head f8afff5b3, after the fix that stopped a tooltip opening with them.
The Last round pairs compare 48ede229b with the final head c06de2fa3: the model chooser before is the gallery's earlier capture, and the checkout strip pair was captured on both builds with a chat whose saved branch, release/1.2, differs from the project's main.
The accent outline on the theme library's selected Mode and colour theme cards is intended: it keeps main's presentation of that picker.

## Batch A: Workspace shell

- Branch menu, light, 1440×920 (`branch-menu-light-1440x920-before.png`, `branch-menu-light-1440x920-after.png`): The branch menu drops its Branches heading, branch count and Start another chat label; search, branches, the new-branch field and the two new-chat actions are plain rows.
- Browser evidence, light, 1440×920 (`browser-evidence-light-1440x920-before.png`, `browser-evidence-light-1440x920-after.png`): The evidence count leaves the address row and the Local evidence header loses its bordered strip.
- Changes More menu, light, 760×600 (`changes-more-menu-light-760x600-before.png`, `changes-more-menu-light-760x600-after.png`): At 760 wide the Git actions fold into More; the review strip below it becomes plain rows with the file picker on its own line.
- Detached chat window, light, 1000×760 (`detached-window-light-1000x760-before.png`, `detached-window-light-1000x760-after.png`): The detached window shows project and chat as one breadcrumb, and the finished turn shows its hover footer with time, duration and Run details.
- Diff line selection, light, 1440×920 (`diff-selection-light-1440x920-before.png`, `diff-selection-light-1440x920-after.png`): Selected diff lines show Ask about, Request revision, Revert, Note and Add to prompt as one quiet toolbar, and the file header no longer truncates the name.
- Diff selection revert, light, 1440×920 (`diff-selection-revert-light-1440x920-before.png`, `diff-selection-revert-light-1440x920-after.png`): The revert form keeps its note field and Revert selected lines; the selection toolbar above it wraps onto two plain rows.
- Header Git menu, light, 1440×920 (`git-menu-light-1440x920-before.png`, `git-menu-light-1440x920-after.png`): The Git menu shrinks from described actions with an outgoing and incoming strip to a plain list of six actions under the branch line.
- Header overflow, light, 760×600 (`header-overflow-light-760x600-before.png`, `header-overflow-light-760x600-after.png`): The narrow header's overflow menu uses the open-in icon for Open in Folder; items and order are unchanged.
- Header overflow, Git actions, light, 760×600 (`header-overflow-git-light-760x600-before.png`, `header-overflow-git-light-760x600-after.png`): Git actions inside the overflow menu become single-line items without descriptions, so the whole list fits without scrolling.
- Attachments panel, light, 1440×920 (`panel-attachments-light-1440x920-before.png`, `panel-attachments-light-1440x920-after.png`): The empty Attachments panel says No attachments instead of a helper sentence, and the active tab uses the neutral fill.
- Changes panel, file selected, light, 1440×920 (`panel-changes-selected-light-1440x920-before.png`, `panel-changes-selected-light-1440x920-after.png`): The selected file's diff header moves Open file to the right and drops the truncated name; the file list and review counts are unchanged.
- Files panel, Markdown preview, light, 1440×920 (`panel-files-markdown-light-1440x920-before.png`, `panel-files-markdown-light-1440x920-after.png`): The Markdown preview is unchanged; the tree marks the open file with the neutral selected fill, and the 760 pair shows the same in the stacked narrow panel.
- Files panel, Markdown preview, light, 760×600 (`panel-files-markdown-light-760x600-before.png`, `panel-files-markdown-light-760x600-after.png`): The Markdown preview is unchanged; the tree marks the open file with the neutral selected fill, and the 760 pair shows the same in the stacked narrow panel.
- Files panel, code preview, light, 1440×920 (`panel-files-preview-light-1440x920-before.png`, `panel-files-preview-light-1440x920-after.png`): The open file's tree row uses the neutral selected fill and the panel tabs drop their bordered active state.
- Goal panel, light, 1440×920 (`panel-goal-light-1440x920-before.png`, `panel-goal-light-1440x920-after.png`): Goal sections lose their tinted cards and helper sentences; objective, plan, skills and delegated work are plain labelled rows.
- Plan panel, light, 1440×920 (`panel-plan-light-1440x920-before.png`, `panel-plan-light-1440x920-after.png`): The empty plan becomes one line, No plan yet, without the progress bar, helper sentence or Refine plan button.
- Usage panel, light, 1440×920 (`panel-usage-light-1440x920-before.png`, `panel-usage-light-1440x920-after.png`): Usage reads No provider limits reported instead of the longer sentence, and the Refresh usage and account buttons are quieter.
- Split view, light, 1440×920 (`split-view-light-1440x920-before.png`, `split-view-light-1440x920-after.png`): Each pane header uses the shared icon buttons, including a terminal button, and the pane composers match the main composer; at 760 the panes stack.
- Split view, light, 760×600 (`split-view-light-760x600-before.png`, `split-view-light-760x600-after.png`): Each pane header uses the shared icon buttons, including a terminal button, and the pane composers match the main composer; at 760 the panes stack.
- Terminal dock, light, 1440×920 (`terminal-dock-light-1440x920-before.png`, `terminal-dock-light-1440x920-after.png`): The terminal dock's tab row is plainer and the tinted resume bar is gone; the shell prompt is a fixture prompt.

## Batch B: Transcript cards and composer popovers

- Composer access menu, light, 1440×920 (`composer-access-menu-light-1440x920-before.png`, `composer-access-menu-light-1440x920-after.png`): The access menu drops its Project access heading and selection dot; the current option uses the neutral fill.
- Composer attachment, light, 1440×920 (`composer-attachment-light-1440x920-before.png`, `composer-attachment-light-1440x920-after.png`): The attached image card keeps its place at the top of the composer; the composer around it is the quiet one.
- Composer preview suggestion, light, 1440×920 (`composer-browser-preview-light-1440x920-before.png`, `composer-browser-preview-light-1440x920-after.png`): Attach current preview becomes one line with its address beside the label, and the carried-context chip above it is one line too.
- Carried context chip, light, 1440×920 (`composer-context-chip-light-1440x920-before.png`, `composer-context-chip-light-1440x920-after.png`): The carried-context chip becomes one line with title, project and message count, plus collapse and close icons.
- Carried context preview, light, 1440×920 (`composer-context-preview-light-1440x920-before.png`, `composer-context-preview-light-1440x920-after.png`): The expanded context lists You and Agent lines as compact rows inside the composer instead of a bordered card with a Close preview button.
- Composer options menu, light, 600×600 (`composer-more-menu-light-600x600-before.png`, `composer-more-menu-light-600x600-after.png`): At 600 wide the options menu drops its heading and shows each setting on one row with the value right-aligned.
- Composer More tools, light, 1440×920 (`composer-more-tools-light-1440x920-before.png`, `composer-more-tools-light-1440x920-after.png`): More tools reveals chat tools, presets and scratch prompts inline beside the send button; opening it no longer leaves a highlight on the scratch prompts button.
- Prompt presets, light, 1440×920 (`composer-presets-light-1440x920-before.png`, `composer-presets-light-1440x920-after.png`): The presets popover drops its heading and count line; search and New share the top row and each preset is one line.
- Prompt preset editor, light, 1440×920 (`composer-presets-editor-light-1440x920-before.png`, `composer-presets-editor-light-1440x920-after.png`): The preset editor drops its heading and count line; the fields and footer are unchanged.
- Queued follow-up, light, 1440×920 (`composer-queued-light-1440x920-before.png`, `composer-queued-light-1440x920-after.png`): The queued follow-up keeps its row and Queued label inside the composer; the composer around it is the quiet one.
- Reasoning menu, light, 1440×920 (`composer-reasoning-menu-light-1440x920-before.png`, `composer-reasoning-menu-light-1440x920-after.png`): The reasoning menu drops its heading and selection dot; the current option uses the neutral fill.
- Skills menu, light, 1440×920 (`composer-skills-menu-light-1440x920-before.png`, `composer-skills-menu-light-1440x920-after.png`): The skills popover drops its heading and hint line, keeping the provider message and a Refresh skills action.
- Slash command menu, light, 1440×920 (`composer-slash-menu-light-1440x920-before.png`, `composer-slash-menu-light-1440x920-after.png`): The slash menu drops its Built-in and Provider headings and keeps one list with a separator.
- Scratch prompts, light, 1440×920 (`composer-stash-light-1440x920-before.png`, `composer-stash-light-1440x920-after.png`): The scratch prompts popover drops its heading and the description under Save current prompt.
- New chat composer, light, 1440×920 (`shell-new-chat-light-1440x920-before.png`, `shell-new-chat-light-1440x920-after.png`): The new chat composer loses its accent border, glow and highlighted Medium chip; the branch is one faint line.
- Approval request, light, 1440×920 (`transcript-approval-light-1440x920-before.png`, `transcript-approval-light-1440x920-after.png`): The approval card drops its Approval required kicker and the paused line; command, reason, location and actions stay.
- Failed turn, details open, light, 1440×920 (`transcript-failed-details-light-1440x920-before.png`, `transcript-failed-details-light-1440x920-after.png`): Opening Details on a failed turn shows the failed step, the execution and process facts and the error cause; the footer reads Failed in the status colour.
- Turn footer on hover, light, 1440×920 (`transcript-finished-footer-hover-light-1440x920-before.png`, `transcript-finished-footer-hover-light-1440x920-after.png`): Hovering a finished turn reveals its footer: time, Worked 1m 36s and Run details.
- Visual reply, light, 1440×920 (`transcript-html-page-light-1440x920-before.png`, `transcript-html-page-light-1440x920-after.png`): The visual reply keeps its content; the composer below loses its accent ring and highlighted Medium chip.
- Usage limit turn, light, 1440×920 (`transcript-limit-light-1440x920-before.png`, `transcript-limit-light-1440x920-after.png`): The usage-limit notice and Continue with another model stay above the composer; the composer is the quiet one.
- Transcript minimap, light, 1440×920 (`transcript-minimap-light-1440x920-before.png`, `transcript-minimap-light-1440x920-after.png`): Hovering the minimap shows a preview card of the step under the pointer.
- Provider question, light, 1440×920 (`transcript-question-light-1440x920-before.png`, `transcript-question-light-1440x920-after.png`): The input request drops its Input required kicker and helper line and uses the provider name as its heading.
- Run details, light, 1440×920 (`transcript-run-details-light-1440x920-before.png`, `transcript-run-details-light-1440x920-after.png`): Run details opens under the footer with the work summary; Diagnostics stays behind its own toggle.
- Run diagnostics, light, 1440×920 (`transcript-run-diagnostics-light-1440x920-before.png`, `transcript-run-diagnostics-light-1440x920-after.png`): With Diagnostics open, harness and backend profile IDs show as a plain two-column list.
- Work log open, light, 1440×920 (`transcript-worklog-open-light-1440x920-before.png`, `transcript-worklog-open-light-1440x920-after.png`): The opened work log lists each step as a plain row under the summary line.
- Usage popover, light, 1440×920 (`usage-popover-light-1440x920-before.png`, `usage-popover-light-1440x920-after.png`): The usage popover keeps its layout; the carried-context chip beside it becomes one line.
- Branch menu, light, 1440×920 (`checkout-branch-menu-light-1440x920-before.png`, `checkout-branch-menu-light-1440x920-after.png`): The branch menu opens from the faint branch line in the composer footer, without its Branches heading, count and Start another chat label.

## Batch C: Dialogs

- Add project, light, 1440×920 (`add-project-light-1440x920-before.png`, `add-project-light-1440x920-after.png`): The Add project dialog drops the source descriptions; Local folder and Clone repository are one line each.
- Clone repository, light, 1440×920 (`add-project-clone-light-1440x920-before.png`, `add-project-clone-light-1440x920-after.png`): The clone form keeps its fields on the shared dialog shell with plainer inputs and a quieter Browse button.
- Open local folder, light, 1440×920 (`add-project-folder-light-1440x920-before.png`, `add-project-folder-light-1440x920-after.png`): The folder form keeps its single field on the shared dialog shell.
- Image attachment viewer, light, 1440×920 (`attachment-image-light-1440x920-before.png`, `attachment-image-light-1440x920-after.png`): The image viewer uses the shared dialog shell; name, size and zoom controls are unchanged.
- PDF attachment viewer, light, 1440×920 (`attachment-pdf-light-1440x920-before.png`, `attachment-pdf-light-1440x920-after.png`): The PDF viewer drops the fallback helper sentence from its footer and keeps Open in PDF app.
- Spreadsheet attachment viewer, light, 1440×920 (`attachment-sheet-light-1440x920-before.png`, `attachment-sheet-light-1440x920-after.png`): The spreadsheet viewer uses the shared dialog shell; content is unchanged.
- Import CLI conversations, light, 1440×920 (`cli-import-light-1440x920-before.png`, `cli-import-light-1440x920-after.png`): The import dialog gains a title and lists sessions as plain rows instead of cards with large provider marks.
- Import CLI conversation preview, light, 1440×920 (`cli-import-preview-light-1440x920-before.png`, `cli-import-preview-light-1440x920-after.png`): The conversation preview sits under the dialog title; content and the Import conversation button are unchanged.
- Command palette, no matches, light, 1440×920 (`command-palette-none-light-1440x920-before.png`, `command-palette-none-light-1440x920-after.png`): No matches becomes one plain line; the placeholder circle, helper sentence and keyboard hint footer are gone.
- Command palette, opened, light, 1440×920 (`command-palette-open-light-1440x920-before.png`, `command-palette-open-light-1440x920-after.png`): Actions lose their description lines and the keyboard hint footer is gone; project paths stay as a second line.
- Commit dialog, light, 1440×920 (`commit-dialog-light-1440x920-before.png`, `commit-dialog-light-1440x920-after.png`): File rows show their state on the right instead of a second line, and the staging sentence is shortened.
- Database recovery notice, light, 1440×920 (`database-recovery-light-1440x920-before.png`, `database-recovery-light-1440x920-after.png`): The recovery notice keeps its text and its two actions as plainer buttons.
- Error toast, light, 1440×920 (`error-toast-light-1440x920-before.png`, `error-toast-light-1440x920-after.png`): The error toast keeps its text and View diagnostics; only spacing changes.
- File editor dialog, light, 1440×920 (`file-editor-dialog-light-1440x920-before.png`, `file-editor-dialog-light-1440x920-after.png`): The editor uses the shared dialog shell; content and actions are unchanged.
- Visual reply dialog, light, 1440×920 (`html-page-dialog-light-1440x920-before.png`, `html-page-dialog-light-1440x920-after.png`): The visual reply dialog uses the shared dialog shell; content is unchanged.
- Launch a duo, light, 1440×920 (`multi-spawn-light-1440x920-before.png`, `multi-spawn-light-1440x920-after.png`): Launch a duo drops the route number badges, Ready ticks, field icons, the judge card and the saved-pairing helper; the 760 pair shows the same change at the narrow width.
- Launch a duo, light, 760×600 (`multi-spawn-light-760x600-before.png`, `multi-spawn-light-760x600-after.png`): Launch a duo drops the route number badges, Ready ticks, field icons, the judge card and the saved-pairing helper; the 760 pair shows the same change at the narrow width.
- Launch a duo, judge, light, 1440×920 (`multi-spawn-judge-light-1440x920-before.png`, `multi-spawn-judge-light-1440x920-after.png`): The judge settings become plain fields under a label instead of a nested card.
- New chat project picker, light, 1440×920 (`new-chat-project-picker-light-1440x920-before.png`, `new-chat-project-picker-light-1440x920-after.png`): The project picker drops the description under No project and sits closer to the composer.
- Pre-merge confidence, light, 1440×920 (`pre-merge-light-1440x920-before.png`, `pre-merge-light-1440x920-after.png`): The confidence dialog drops its kicker, source chips and nested check cards; checks are plain rows with status text.
- Pre-merge, needs attention, light, 1440×920 (`pre-merge-attention-light-1440x920-before.png`, `pre-merge-attention-light-1440x920-after.png`): The failing state lists checks, the review thread and the affected scope as plain rows.
- Project filter, light, 1440×920 (`project-filter-light-1440x920-before.png`, `project-filter-light-1440x920-after.png`): The project filter's selected row uses the neutral fill instead of a tint.
- Usage limits dialog, light, 1440×920 (`provider-limits-dialog-light-1440x920-before.png`, `provider-limits-dialog-light-1440x920-after.png`): Limits becomes Usage limits; provider rows lose their card borders and the Usage sources disclosure loses its triangle.
- Pull request dialog, light, 1440×920 (`pull-request-light-1440x920-before.png`, `pull-request-light-1440x920-after.png`): The pull request dialog uses the shared dialog shell; fields and actions are unchanged.
- Review note dialog, light, 1440×920 (`review-note-dialog-light-1440x920-before.png`, `review-note-dialog-light-1440x920-after.png`): The review note dialog uses the shared dialog shell; the field is unchanged.
- Snapshot error, light, 1440×920 (`snapshot-error-light-1440x920-before.png`, `snapshot-error-light-1440x920-after.png`): The snapshot error drops its tinted box; message and guidance are plain text.
- Restart to update, light, 1440×920 (`update-confirm-light-1440x920-before.png`, `update-confirm-light-1440x920-after.png`): The restart confirmation gains a close button in its corner; text and actions are unchanged.
- Update ready to download, light, 1440×920 (`update-details-light-1440x920-before.png`, `update-details-light-1440x920-after.png`): The update popover keeps its content; only spacing changes.
- Update ready to install, light, 1440×920 (`update-ready-light-1440x920-before.png`, `update-ready-light-1440x920-after.png`): The ready-to-install popover keeps its content; only spacing changes.
- Usage, Limits tab, light, 1440×920 (`usage-limits-light-1440x920-before.png`, `usage-limits-light-1440x920-after.png`): Provider rows lose their card borders and the History and Limits tabs use the neutral fill.
- Usage, History tab, light, 1440×920 (`usage-view-light-1440x920-before.png`, `usage-view-light-1440x920-after.png`): The Insight card and inner borders are gone; chart, totals and breakdown sit on one surface.
- Commit dialog, narrow, light, 760×600 (`commit-dialog-light-760x600-before.png`, `commit-dialog-light-760x600-after.png`): At 760 wide the dialog drops its icon tile and uppercase heading, and file rows put their state on the right.

## Batch D: Settings, guides and theme library

- Empty project composer, light, 1440×920 (`composer-welcome-light-1440x920-before.png`, `composer-welcome-light-1440x920-after.png`): The empty-project composer loses its accent border and glow.
- Help, light, 1440×920 (`help-guide-light-1440x920-before.png`, `help-guide-light-1440x920-after.png`): Help drops the topic card borders and the Topic 1 of 12 footer; Close becomes an icon.
- Help, demo topic, light, 1440×920 (`help-guide-demo-light-1440x920-before.png`, `help-guide-demo-light-1440x920-after.png`): The demo above Following work loses its tinted frame and the topic sections are plain.
- Help search, light, 1440×920 (`help-guide-search-light-1440x920-before.png`, `help-guide-search-light-1440x920-after.png`): Search results lose their card fill; the follow-up links stay as buttons.
- Mascot bubble, keyboard focus, light, 240×240 (`mascot-overlay-focus-light-240x240-before.png`, `mascot-overlay-focus-light-240x240-after.png`): Keyboard focus on the mascot bubble draws the accent ring instead of a yellow one.
- Project customise popover, light, 1440×920 (`project-customize-light-1440x920-before.png`, `project-customize-light-1440x920-after.png`): The colour swatches wrap onto two rows, the icon grid gets its own rows and the All project settings link is gone.
- Provider sign-in dialog, light, 1440×920 (`provider-auth-dialog-light-1440x920-before.png`, `provider-auth-dialog-light-1440x920-after.png`): The sign-in dialog drops the provider tile and subtitle; the sign-in terminal and footer actions are unchanged.
- Settings, backend editor, light, 1440×920 (`settings-agents-backend-editor-light-1440x920-before.png`, `settings-agents-backend-editor-light-1440x920-after.png`): The backend editor drops its helper line and the provider list sits on the same surface.
- Settings, Agents, Claude, light, 1440×920 (`settings-agents-claude-light-1440x920-before.png`, `settings-agents-claude-light-1440x920-after.png`): Provider rows lose their card borders and the Configuration and Models tabs use the neutral fill.
- Settings, Agents, light, 1440×920 (`settings-agents-p1-light-1440x920-before.png`, `settings-agents-p1-light-1440x920-after.png`): The Agents page drops its helper sentence and the provider list and detail share one surface; the 760 pair shows the same change in the stacked narrow layout.
- Settings, Agents, light, 760×600 (`settings-agents-p1-light-760x600-before.png`, `settings-agents-p1-light-760x600-after.png`): The Agents page drops its helper sentence and the provider list and detail share one surface; the 760 pair shows the same change in the stacked narrow layout.
- Settings, custom backend, light, 1440×920 (`settings-agents-p2-light-1440x920-before.png`, `settings-agents-p2-light-1440x920-after.png`): The custom backend detail keeps its fields as plainer rows on the same surface.
- Settings, Appearance, light, 1440×920 (`settings-appearance-p1-light-1440x920-before.png`, `settings-appearance-p1-light-1440x920-after.png`): Helper sentences under Colour theme, Muted colours and the scale rows are gone and the theme cards lose their borders.
- Settings, Appearance, working indicator, light, 1440×920 (`settings-appearance-p2-light-1440x920-before.png`, `settings-appearance-p2-light-1440x920-after.png`): The working indicator Colour row loses its helper line; the rest is spacing.
- Settings, Chats, light, 1440×920 (`settings-chats-p1-light-1440x920-before.png`, `settings-chats-p1-light-1440x920-after.png`): Toggle rows drop most helper lines, such as those under reasoning summaries, work logs and code wrapping.
- Settings, Data, light, 1440×920 (`settings-data-p1-light-1440x920-before.png`, `settings-data-p1-light-1440x920-after.png`): Remove oldest files drops its helper line and Restore defaults moves up into view; storage rows keep their figures.
- Settings, Devices and integrations, light, 1440×920 (`settings-devices-integrations-p1-light-1440x920-before.png`, `settings-devices-integrations-p1-light-1440x920-after.png`): Private Connect rows drop helper lines, and the How to take a snapshot disclosure no longer shows under Capture access.
- Settings, Help, light, 1440×920 (`settings-help-p1-light-1440x920-before.png`, `settings-help-p1-light-1440x920-after.png`): The issue form keeps its fields; Diagnostics and Process health sit higher with less spacing.
- Settings, Keyboard, light, 1440×920 (`settings-keyboard-p1-light-1440x920-before.png`, `settings-keyboard-p1-light-1440x920-after.png`): Shortcut rows drop their helper lines, including the fixed-key note and the global shortcut explanation.
- Settings, Notifications, light, 1440×920 (`settings-notifications-open-p1-light-1440x920-before.png`, `settings-notifications-open-p1-light-1440x920-after.png`): Sound choices lose their descriptions and card borders and the toggles drop their helper lines.
- Settings select menu, light, 1440×920 (`settings-picker-light-1440x920-before.png`, `settings-picker-light-1440x920-after.png`): The open select menu marks the current option with the neutral fill.
- Settings, Projects, light, 1440×920 (`settings-projects-p1-light-1440x920-before.png`, `settings-projects-p1-light-1440x920-after.png`): Group projects and Compact sidebar drop their helper lines.
- Settings search, light, 1440×920 (`settings-search-light-1440x920-before.png`, `settings-search-light-1440x920-after.png`): The filtered section list is unchanged; the Appearance page beside it shows the borderless theme cards.
- Settings, working indicator advanced, light, 1440×920 (`settings-working-indicator-light-1440x920-before.png`, `settings-working-indicator-light-1440x920-after.png`): The Colour helper line is gone and the open Advanced option sits under Speed with less spacing.
- Theme library, light, 1440×920 (`theme-library-light-1440x920-before.png`, `theme-library-light-1440x920-after.png`): Mode and colour theme cards show the selected one with an outline instead of a filled card, and the helper lines are gone; the dark pair shows Dark mode selected.
- Theme library, dark, 1440×920 (`theme-library-dark-1440x920-before.png`, `theme-library-dark-1440x920-after.png`): Mode and colour theme cards show the selected one with an outline instead of a filled card, and the helper lines are gone; the dark pair shows Dark mode selected.
- Welcome guide, step 1, light, 1440×920 (`welcome-guide-1-light-1440x920-before.png`, `welcome-guide-1-light-1440x920-after.png`): The first step drops its Step 1 of 4 kicker, the subtitle and the card descriptions.
- Welcome guide, How it works, light, 1440×920 (`welcome-guide-2-light-1440x920-before.png`, `welcome-guide-2-light-1440x920-after.png`): How it works drops its kicker; the demo sits without the tinted frame.
- Welcome guide, Connect an agent, light, 1440×920 (`welcome-guide-3-light-1440x920-before.png`, `welcome-guide-3-light-1440x920-after.png`): Connect an agent lists providers as plain rows with Set up buttons instead of a card grid and drops the ready count line.
- Welcome guide, last step, light, 1440×920 (`welcome-guide-4-light-1440x920-before.png`, `welcome-guide-4-light-1440x920-after.png`): The last step drops the check icon, the summary line and the Add a project card for one small button.
- Settings, Codex models, light, 1440×920 (`settings-agents-models-light-1440x920-before.png`, `settings-agents-models-light-1440x920-after.png`): The models list keeps its entries; provider rows and the detail lose their borders and the Models tab uses the neutral fill.
- Welcome guide, first step, light, 1440×920 (`intro-1-light-1440x920-before.png`, `intro-1-light-1440x920-after.png`): The first step drops its Step 1 of 4 kicker, subtitle and card descriptions.
- Welcome guide, Split view, light, 1440×920 (`intro-2-split-view-light-1440x920-before.png`, `intro-2-split-view-light-1440x920-after.png`): How it works drops its kicker and the demo loses its tinted frame.
- Welcome guide, Work tab, light, 1440×920 (`intro-2-work-tab-light-1440x920-before.png`, `intro-2-work-tab-light-1440x920-after.png`): The Work tab demo loses its tinted frame; the content is unchanged.
- Welcome guide, Duo, light, 1440×920 (`intro-2-duo-light-1440x920-before.png`, `intro-2-duo-light-1440x920-after.png`): The Duo demo loses its tinted frame and the brief chip its fill.
- Welcome guide, Review and ship, light, 1440×920 (`intro-2-review-and-ship-light-1440x920-before.png`, `intro-2-review-and-ship-light-1440x920-after.png`): The diff demo drops its coloured line bars for plain ones.
- Welcome guide, Limits, light, 1440×920 (`intro-2-limits-light-1440x920-before.png`, `intro-2-limits-light-1440x920-after.png`): The Limits demo loses its tinted frame; the meter is unchanged.
- Welcome guide, Shortcuts, light, 1440×920 (`intro-2-shortcuts-light-1440x920-before.png`, `intro-2-shortcuts-light-1440x920-after.png`): The Shortcuts demo loses its tinted frame and the selected result its accent fill.
- Welcome guide, reduced motion, light, 1440×920 (`intro-2-reduced-light-1440x920-before.png`, `intro-2-reduced-light-1440x920-after.png`): With reduced motion the step shows the still Split view demo without the kicker.
- Welcome guide, Connect an agent, light, 1440×920 (`intro-3-light-1440x920-before.png`, `intro-3-light-1440x920-after.png`): Providers become plain rows instead of a card grid, and the ready count line is gone.
- Welcome guide, last step, light, 1440×920 (`intro-4-light-1440x920-before.png`, `intro-4-light-1440x920-after.png`): The last step drops the check icon, the summary line and the Add a project card for one small button.

## Fix round

- Reasoning menu, keyboard focus, light, 1440×920 (`fix-reasoning-menu-focus-light-1440x920-before.png`, `fix-reasoning-menu-focus-light-1440x920-after.png`): With Extra high focused from the keyboard, the after marks the current level with a check; the before shows no check, so both filled rows look alike.
- Composer mode menu, light, 1440×920 (`fix-composer-mode-menu-light-1440x920-before.png`, `fix-composer-mode-menu-light-1440x920-after.png`): The Mode title is gone and the current mode carries a check.
- Header Git menu, light, 1440×920 (`fix-git-menu-light-1440x920-before.png`, `fix-git-menu-light-1440x920-after.png`): The branch and upstream line at the top reads the same; the fixture branch has no upstream, so no outgoing or incoming counts show on either side.
- Database recovery notice with a toast, light, 1440×920 (`fix-database-recovery-toast-light-1440x920-before.png`, `fix-database-recovery-toast-light-1440x920-after.png`): The recovery notice becomes the first item of the toast stack, with the error toast below it; before, it was a wide banner drawn over the stack, which hides the error toast.
- Project colour swatches, Default selected, light, 1440×920 (`fix-project-swatches-light-1440x920-before.png`, `fix-project-swatches-light-1440x920-after.png`): The ring around the selected Default swatch is drawn darker so it stands out from the other swatches.
- Help search, light, 1440×920 (`fix-help-search-light-1440x920-before.png`, `fix-help-search-light-1440x920-after.png`): Matches of the typed word get a light fill in addition to bold.
- Usage error, light, 760×600 (`fix-usage-error-light-760x600-before.png`, `fix-usage-error-light-760x600-after.png`): The error row is unchanged at this width: Try again sits beside the message in both builds.
- Selected diff line under the pointer, light, 1440×920 (`fix-diff-line-hover-light-1440x920-before.png`, `fix-diff-line-hover-light-1440x920-after.png`): The selected line keeps the selected fill while the pointer rests on it.
- Goal panel with a plan, light, 1440×920 (`fix-goal-plan-light-1440x920-before.png`, `fix-goal-plan-light-1440x920-after.png`): The plan summary loses its padded row and reads as one plain column under Latest conversation plan.
- Sidebar row actions, light, 1440×920 (`fix-sidebar-row-actions-light-1440x920-before.png`, `fix-sidebar-row-actions-light-1440x920-after.png`): The row's snooze and settle buttons are 24px and centred in the 32px row; they show here through keyboard focus, which reveals the same buttons as hover.
- Review note for a long path, light, 1440×920 (`fix-review-note-long-title-light-1440x920-before.png`, `fix-review-note-long-title-light-1440x920-after.png`): The dialog title wraps onto several lines to show the whole path instead of cutting it off.
- Launch a duo, light, 1440×920 (`fix-duo-dialog-light-1440x920-before.png`, `fix-duo-dialog-light-1440x920-after.png`): The dialog's description line under the title and the privacy line under Save this pairing are back.
- Provider question, light, 1440×920 (`fix-question-card-light-1440x920-before.png`, `fix-question-card-light-1440x920-after.png`): The provider's short question header, Presentation, shows above the question.
- Plan steps in the work log, light, 1440×920 (`fix-worklog-plan-steps-light-1440x920-before.png`, `fix-worklog-plan-steps-light-1440x920-after.png`): The plan steps look the same; the change gives each step its status in words for screen readers.
- Turn footer on hover, light, 1440×920 (`fix-footer-hover-light-1440x920-before.png`, `fix-footer-hover-light-1440x920-after.png`): A separator dot is back between the time and Worked 1m 36s.
- Usage limit banner, light, 1440×920 (`fix-limit-banner-light-1440x920-before.png`, `fix-limit-banner-light-1440x920-after.png`): The banner keeps its text; Continue with another model is drawn slightly larger, at the composer's control size.
- Browser panel while a page loads, light, 1440×920 (`fix-browser-loading-light-1440x920-before.png`, `fix-browser-loading-light-1440x920-after.png`): The address row shows the loading mark at the start of the field while the page loads.

## Last round

- Model chooser, saved combinations, light, 1440×920 (`model-chooser-favorites-light-1440x920-before.png`, `model-chooser-favorites-light-1440x920-after.png`): Each model row ends in a star for saving the combination instead of a pin; the before is the gallery's model chooser from 48ede229b.
- Composer checkout strip, differing branch, light, 1440×920 (`composer-checkout-strip-light-1440x920-before.png`, `composer-checkout-strip-light-1440x920-after.png`): A chat saved on release/1.2 while the project is on main: the before says Current checkout twice, as a label on the left and in the branch control; the after says it once, in the branch control.


## Sidebar (owner correction, 2026-10-12)

Before is a build of main; after is this branch. Project grouping is gone (main's Work list order is back) and rows follow Synara's two-line layout.

- sidebar-synara-light-1440x920: main vs branch, light.
- sidebar-synara-dark-1440x920: main vs branch, dark.

## Handoff divider logos (owner, 2026-10-12)

Before is the branch without logos; after shows the two provider marks next to the provider names. Nothing else on the divider changed.

- handoff-logos-light-1440x920: light.
- handoff-logos-dark-1440x920: dark.

## Queued messages (owner, 2026-10-12)

Before is a build of main; after is this branch: the queue is a card above the composer again, as on main, with token-level polish only.

- composer-queue-light-1440x920: light.
- composer-queue-dark-1440x920: dark.
