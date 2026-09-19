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

## Bundle accounting

The baseline and implementation use the identical dependency graph. The necessary reference ownership/hydration guards add 1,032 bytes to each initial route. Preview feedback and the expansion correction bring the total core addition to 1,186 bytes. Only these exact measured additions were added to exceeded ceilings, retaining their previous headroom. All other ceilings and static-import assertions remain unchanged. See `renderer-bundle.json` for every measured metric.

The external-review corrections add another 806 bytes to main first load, 699 to detached first load, and 2,699 total core JavaScript bytes. Context cards stay deferred. The same-dependency measurements are in `pro-review-renderer-bundle.json`; only the initial measured consent/error/activity deltas were added to exceeded ceilings. The final disclosure-navigation fix and acknowledgement wording consume 66 bytes of retained core headroom without another ceiling increase. CSS remains within its existing ceiling.

## Verification

- `npm run check`: passed; 868 test files passed, 16 skipped; 9,249 tests passed, 145 skipped. Workflow policy, immutable migrations, architecture, color themes, both lint layers, all TypeScript targets, production builds and bundle budgets passed.
- `npm run test:portable`: passed; 99 files, 1,385 tests passed, 9 skipped.
- Focused external-review regressions: encoded one/two-reference assembly and immutable previews/receipts; workspace consent/cancellation and request retry; bounded older running activity and settlement; sprite backup-cleanup fault injection. These passed individually and in the final full gate. Earlier corrections plus the Git fixture recheck passed 114 tests.
- Electron repetition: Quiet Ledger and transcript navigation, each twice with one worker: 4 passed (41.3 seconds). Final Electron matrix: `npx playwright test tests/e2e/quiet-ledger.spec.ts tests/e2e/transcript.spec.ts tests/e2e/conversation-context.spec.ts tests/e2e/usage-limits.spec.ts tests/e2e/activity-lifecycle.spec.ts tests/e2e/mascot-sprites.spec.ts --project=display-sensitive --project=isolated --workers=1`: 7 passed (53.1 seconds). This covers native consent cancellation/acceptance, reference previews, activity settlement, quota layouts, transcript controls and sprite apply/restart/reset. The only subsequent renderer change clarifies the acknowledgement text from “Chat shared” to “Sharing approved”; the full gate was rerun afterward.

Native Windows x64 and Linux ARM64 jobs cannot be run on this macOS ARM64 host. The failed job logs and Linux trace were inspected, and their scenarios are exercised locally. Live authenticated provider sessions and packaged builds were not exercised; provider fixtures remain deterministic and secret-free.

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
- `src/renderer/src/components/composer/Composer.tsx`
- `src/renderer/src/components/composer/ComposerConversationContextCards.tsx`
- `src/renderer/src/components/composer/ComposerInputZone.tsx`
- `src/renderer/src/components/composer/useComposerConversationContext.tsx`
- `src/renderer/src/components/conversation-context/types.ts`
- `src/renderer/src/components/response-timeline/activity.tsx`
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
- `tests/e2e/support/markdown-controls.ts`
- `tests/e2e/usage-limits.spec.ts`
- `tests/main/mascot-sprites.test.ts`
- `tests/renderer/activity-summary.test.ts`
- `tests/renderer/agent-loading-state.dom.test.tsx`
- `tests/renderer/composer-chat-references.dom.test.tsx`
- `tests/renderer/composer-ownership.dom.test.tsx`
- `tests/renderer/response-timeline.test.ts`
- `tests/server/claude-delegate-lifecycle.test.ts`
- `tests/server/claude-resume-queued-prompt.test.ts`
- `tests/server/claude-transport.test.ts`
- `tests/server/claude-update-continuity.test.ts`
- `tests/server/conversation-context-packets.test.ts`
