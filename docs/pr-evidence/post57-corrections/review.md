# Post-v57 corrections

Branch: `codex/post57-corrections`, published as PR #421. Based on main `c95a049bb35e5277c4ac4c5c1e93d5a26a276b64` (#416). No version bump or release is included.

## Corrections

The first review's fixes are in `7133df2e`: a background Claude acknowledgement cannot complete the foreground turn; an oversized stderr line stays discarded until its line terminator; shared-context source reads remain bounded without cutting at NULs or exposing a partial credential at a storage boundary.

The second review adds:

- Chat reference creation blocks sending, queueing, live follow-up and compaction until its acknowledged packet appears in conversation detail. It acquires its lock synchronously, retains the mention on failure, and cannot clear another chat's draft or subsequent edits.
- Draft previews, summary counts and sent receipts use the same bounded selection as provider transport. Two references share the transport budget; removing one restores the other's larger preview. A sent receipt uses its original request cohort, and an agent-requested receipt uses the smaller host-tool budget. Stored packets and released migrations remain immutable. Open previews reload when the selected packet set changes and label shortened excerpts.
- Claude update recovery joins bounded BLOB text and durable chunks before redaction. It preserves embedded NUL suffixes and complete UTF-8 characters, reads past 32 tiny chunks, and omits an incomplete trailing token at the source cap before redacting known credentials. The final 4 KiB message and 40 KiB history limits are unchanged.

## External review corrections

All three supplied GPT Pro reports were read and checked against this branch. `external-review-triage.md` maps their individual findings, duplicates, disputed CI diagnoses and remaining release qualification.

- Shared-context packing accounts for the final JSON encoding and enforces the three-block limit. One/two JSON-heavy histories reproduce the original rejected-send bug through the real request assembler; previews, sent blobs and immutable receipts now agree.
- Sharing across workspaces requires deliberate acknowledgement with visible source/target paths. Manual references use native confirmation; agent-requested references use an unchecked checkbox, including preselected sources. Changing the selected source or workspace invalidates acknowledgement.
- Context previews show errors and offer Retry/Close. Failed share/decline requests retain their selection and can be retried; accepted requests cannot be submitted twice. A successful selection reports “Sharing approved” because command acknowledgement precedes provider delivery.
- The activity window preserves up to four older running operations alongside recent history and offers a separate disclosure for additional running operations. Completed history remains bounded, order and latest-failure disclosure stay intact, and virtualization estimates include these rows.
- A committed sprite replacement succeeds even when deleting its old backup fails. Reset removes that backup first to avoid restoring obsolete sprites after a failed reset. Fault-injection coverage preserves the earlier rollback path.
- The chat guide correctly locates Snapshots in Settings. Released migrations, provider identities, optimization authority checks and release versions remain unchanged.

## Main #416 failures

Failed run: https://github.com/eduardtomas1/inertia/actions/runs/35439933146

- Linux ARM64: `quiet-ledger.spec.ts` lost the changed-files disclosure after opening Run details. Expansion anchoring could choose an overscanned row below the viewport; a tall source turn could also have a genuinely visible following row whose preservation evicted the clicked source. Anchor selection now requires viewport intersection and keeps tall source turns in place while preserving following-row anchoring for shorter turns. Repeated native checks additionally exposed the parent follow-latest ResizeObserver scrolling to the bottom as the disclosure grew. Captured scroll-call stacks identify that handler and its correction frames. Disclosures now claim reader navigation synchronously before resizing, cancelling competing final-answer/follow-latest ownership through the existing navigation callback. The strengthened native regression opens a tall turn at the viewport top with the next row visible, asserts reader-history mode, and exercises changed-file and code controls. This sequence failed before the correction; repeated Quiet Ledger and transcript scenarios pass afterward without longer timeouts, forced clicks, or skipped assertions. Temporary diagnostic probes were removed.
- Windows x64: `usage-limits.spec.ts` tried to click a quota notice as its normal lifetime ended. Its native and hub fixtures also advanced reset timestamps on every request, changing notice identity. The fixture now shares a stable observation time and waits for normal notice expiry before layout captures. Quota notice behavior is not suppressed or changed.

## PR review: discarded Claude prompts

Codex review [discussion_r4053471638](https://github.com/eduardtomas1/inertia/pull/421#discussion_r4053471638) identified a missing terminal lifecycle state. A queued prompt can receive a background acknowledgement and then `discarded` while the SDK iterator stays open. The gate now reports `prompt-discarded` as an incomplete terminal outcome and the harness explains that Claude discarded the request before answering. Another prompt's command UUID cannot end the current turn.

The regression fixture keeps the SDK stream open after the terminal frame and detects any further read deterministically, without a timer or a synthetic EOF. Both the lifecycle and open-stream discard regressions failed before the fix; the four focused lifecycle files pass all 26 tests afterward, including successful resume, refusal, cancellation, delegation and cleanup. The same fixture now verifies closure for all three command failure states. The complete local gate passed with 9,249 tests and the portable suite passed with 1,385 tests after this correction. Live authenticated Claude sessions were not exercised.

## PR #421 CI corrections

Failed run: https://github.com/eduardtomas1/inertia/actions/runs/35450278386 (head `0adf8cdb`). Both Windows architectures failed the cross-workspace confirmation scenario; both Linux architectures failed mature-profile subagent activation. The macOS lanes passed. `merge-ready` failed because of those platform failures.

- Windows: the second workspace was seeded with a raw path, while startup identity inspection changed its casing and separators. Seed it with `inspectProjectIdentity`, as the primary fixture already does. Keep the exact source and target path assertions and the decline/accept checks; no production consent behavior changes.
- Linux: reproduced the failure locally under Xvfb with the same reviewed dependencies. Pointer-event probes showed the summary moving from y=520.609 to y=480.609 on pointer down, before release. Mouse up landed on the answer and click targeted the containing turn, leaving the disclosure closed. The new synchronous reader-navigation claim exposed this pre-activation layout change. Claim navigation and capture the anchor on activation instead, still before expansion. Apply that ordering to subagents, native details, Run details, and failure diagnostics. Cancelled pointer presses do not claim navigation; keyboard activation and post-expansion restoration remain covered.
- The native background regression explicitly starts in follow-latest mode and uses an ordinary click. It reproduced the original failure before the correction. Temporary event probes were removed; no retries, forced clicks, added sleeps, longer timeouts, or reduced performance assertions remain.
- An older source-string test required a key-down handler rather than observable keyboard behavior. Removed that implementation assertion; the anchored disclosure DOM test continues to verify keyboard activation and anchor ordering.
- Focused renderer verification: 66 tests passed across disclosure lifecycle, subagents, failure diagnostics, metadata, and transcript/workspace anchors. Three regressions demonstrated premature navigation before the correction; the final suite also covers Run details. Existing project-identity and fixture-identity tests passed (3 tests), including explicit Windows normalization.
- Linux ARM64, Ubuntu 24.04 container with Xvfb: five Electron scenarios passed (1.6 minutes), covering mature-profile visible/background motion and idle work, cross-workspace native consent, reference provenance, Quiet Ledger, and transcript navigation. The isolated container used Electron's test-only sandbox override; it does not qualify packaged sandbox behavior.
- macOS ARM64: four display-sensitive consent/Quiet Ledger/transcript scenarios passed (23.4 seconds), and the delegated-agent interaction/persistence scenario passed (7.6 seconds).
- Full gate: `VITEST_MAX_WORKERS=4 npm run check` passed (868 files, 9,253 tests; 16 files / 145 tests skipped). This local concurrency limit avoids contention while the Git fixture creates 1,000 refs; the complete Git-workflow and Quiet Ledger suites also passed separately (74 tests). No production or test deadlines changed.
- Same-dependency emitted output shrank by 374 core/transcript JavaScript bytes and 138 deferred failure-diagnostics bytes. Startup closures are unchanged; all existing budgets pass without adjustment.

Local evidence: `/tmp/inertia-421-linux-background-fast-negative.log`, `/tmp/inertia-421-pointer-dom-before.log`, `/tmp/inertia-421-pointer-dom-after.log`, `/tmp/inertia-421-linux-native.log`, `/tmp/inertia-421-mac-native.log`, `/tmp/inertia-421-mac-subagents.log`, and `/tmp/inertia-421-ci-fix-check-final.log`. Linux artifacts were retained locally and the temporary container was removed. Native Windows and Linux x64 validation remains with CI.

## Bundle accounting

The baseline and implementation use the identical dependency graph. The necessary reference ownership/hydration guards add 1,032 bytes to each initial route. Preview feedback and the expansion correction bring the total core addition to 1,186 bytes. Only these exact measured additions were added to exceeded ceilings, retaining their previous headroom. All other ceilings and static-import assertions remain unchanged. See `renderer-bundle.json` for every measured metric.

The external-review corrections, including the CI follow-up, add 806 bytes to main first load, 699 to detached first load, and 2,325 total core JavaScript bytes. Context cards stay deferred. The same-dependency measurements are in `pro-review-renderer-bundle.json`; only the initial measured consent/error/activity deltas were added to exceeded ceilings. The earlier disclosure-navigation fix and acknowledgement wording consumed 66 bytes of retained core headroom; the CI activation-order correction then recovered 374 bytes. Neither changed the ceiling. CSS remains within its existing ceiling.

## Verification

- `VITEST_MAX_WORKERS=4 npm run check`: passed; 868 test files passed, 16 skipped; 9,253 tests passed, 145 skipped. Workflow policy, immutable migrations, architecture, color themes, both lint layers, all TypeScript targets, production builds and bundle budgets passed.
- `npm run test:portable`: passed; 99 files, 1,385 tests passed, 9 skipped.
- Focused external-review regressions: encoded one/two-reference assembly and immutable previews/receipts; workspace consent/cancellation and request retry; bounded older running activity and settlement; sprite backup-cleanup fault injection. These passed individually and in the final full gate. Earlier corrections plus the Git fixture recheck passed 114 tests.
- Electron repetition: Quiet Ledger and transcript navigation, each twice with one worker: 4 passed (41.3 seconds). Final Electron matrix: `npx playwright test tests/e2e/quiet-ledger.spec.ts tests/e2e/transcript.spec.ts tests/e2e/conversation-context.spec.ts tests/e2e/usage-limits.spec.ts tests/e2e/activity-lifecycle.spec.ts tests/e2e/mascot-sprites.spec.ts --project=display-sensitive --project=isolated --workers=1`: 7 passed (53.1 seconds). This covers native consent cancellation/acceptance, reference previews, activity settlement, quota layouts, transcript controls and sprite apply/restart/reset. The only subsequent renderer change clarifies the acknowledgement text from “Chat shared” to “Sharing approved”; the full gate was rerun afterward.

Native Windows and Linux x64 jobs were not run locally. A Linux ARM64 container subsequently reproduced and verified the PR CI correction as described above; the initial main-failure review used job logs and native macOS checks. Live authenticated provider sessions and packaged builds were not exercised; provider fixtures remain deterministic and secret-free.

One earlier full-suite run timed out while a Git test fixture created 1,000 refs during a concurrent comparison build; the isolated Git suite and focused corrections passed afterward (114 tests). The final gate passed without that competing build.

Discarded-prompt follow-up logs: `/tmp/inertia-421-discarded-before.log`, `/tmp/inertia-421-discarded-focused.log`, `/tmp/inertia-421-discarded-check.log`, and `/tmp/inertia-421-discarded-portable.log`.

Earlier local verification logs: `/tmp/inertia-pro-review-final-gate.log`, `/tmp/inertia-pro-review-final-portable.log`, `/tmp/inertia-pro-review-final-electron.log`, and `/tmp/inertia-disclosure-follow-native.log`. Electron screenshots remain under `/tmp/inertia-pro-review-final-electron`; the earlier failing expansion trace and captured scroll stacks in `/tmp/inertia-pro-expansion-probe3` were used to diagnose the competing resize handler.

## Changed files on this branch

- `docs/pr-evidence/post57-corrections/external-review-triage.md`
- `docs/pr-evidence/post57-corrections/pro-review-renderer-bundle.json`
- `docs/pr-evidence/post57-corrections/renderer-bundle.json`
- `docs/pr-evidence/post57-corrections/review.md`
- `docs/user/chats-and-agents.md`
- `scripts/check-renderer-bundle.mjs`
- `src/main/mascot-sprites.ts`
- `src/renderer/src/components/SubagentDisclosure.tsx`
- `src/renderer/src/components/composer/Composer.tsx`
- `src/renderer/src/components/composer/ComposerConversationContextCards.tsx`
- `src/renderer/src/components/composer/ComposerInputZone.tsx`
- `src/renderer/src/components/composer/useComposerConversationContext.tsx`
- `src/renderer/src/components/conversation-context/types.ts`
- `src/renderer/src/components/response-timeline/activity.tsx`
- `src/renderer/src/components/response-timeline/failurePanel.tsx`
- `src/renderer/src/components/response-timeline/metadata.tsx`
- `src/renderer/src/components/response-timeline/viewport.tsx`
- `src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts`
- `src/renderer/src/styles.css`
- `src/renderer/src/utils/response-timeline/activity-summary.ts`
- `src/renderer/src/utils/response-timeline/virtualization.ts`
- `src/server/persistence/bounded-message-text.ts`
- `src/server/persistence/continuation-history.ts`
- `src/server/persistence/conversation-context-packet-repository.ts`
- `src/server/persistence/conversation-context-source.ts`
- `src/server/persistence/conversation-context-transport.ts`
- `src/server/provider/claude-agent-sdk-harness.ts`
- `src/server/provider/claude-delegate-lifecycle.ts`
- `src/server/provider/claude-owned-query.ts`
- `src/server/runtime/conversation-context-service.ts`
- `tests/e2e/conversation-context.spec.ts`
- `tests/e2e/quiet-ledger.spec.ts`
- `tests/e2e/renderer-background.spec.ts`
- `tests/e2e/support/markdown-controls.ts`
- `tests/e2e/usage-limits.spec.ts`
- `tests/main/mascot-sprites.test.ts`
- `tests/renderer/activity-summary.test.ts`
- `tests/renderer/agent-loading-state.dom.test.tsx`
- `tests/renderer/anchored-details-toggle.dom.test.tsx`
- `tests/renderer/composer-chat-references.dom.test.tsx`
- `tests/renderer/composer-ownership.dom.test.tsx`
- `tests/renderer/failure-diagnostics.dom.test.tsx`
- `tests/renderer/quiet-ledger-settled-work.test.ts`
- `tests/renderer/response-timeline.test.ts`
- `tests/renderer/subagent-disclosure.dom.test.tsx`
- `tests/server/claude-delegate-lifecycle.test.ts`
- `tests/server/claude-resume-queued-prompt.test.ts`
- `tests/server/claude-transport.test.ts`
- `tests/server/claude-update-continuity.test.ts`
- `tests/server/conversation-context-packets.test.ts`
