# Post-v57 corrections

Branch: `codex/post57-corrections`. Based on main `c95a049bb35e5277c4ac4c5c1e93d5a26a276b64` (#416). No PR, push, merge, version bump or release is part of this handoff.

## Corrections

The first review's fixes are in `7133df2e`: a background Claude acknowledgement cannot complete the foreground turn; an oversized stderr line stays discarded until its line terminator; shared-context source reads remain bounded without cutting at NULs or exposing a partial credential at a storage boundary.

The second review adds:

- Chat reference creation blocks sending, queueing, live follow-up and compaction until its acknowledged packet appears in conversation detail. It acquires its lock synchronously, retains the mention on failure, and cannot clear another chat's draft or subsequent edits.
- Draft previews, summary counts and sent receipts use the same bounded selection as provider transport. Two references share the transport budget; removing one restores the other's larger preview. A sent receipt uses its original request cohort, and an agent-requested receipt uses the smaller host-tool budget. Stored packets and released migrations remain immutable. Open previews reload when the selected packet set changes and label shortened excerpts.
- Claude update recovery joins bounded BLOB text and durable chunks before redaction. It preserves embedded NUL suffixes and complete UTF-8 characters, reads past 32 tiny chunks, and omits an incomplete trailing token at the source cap before redacting known credentials. The final 4 KiB message and 40 KiB history limits are unchanged.

## Main #416 failures

Failed run: https://github.com/eduardtomas1/inertia/actions/runs/35439933146

- Linux ARM64: `quiet-ledger.spec.ts` lost the changed-files disclosure after opening Run details. Expansion anchoring could choose an overscanned row below the viewport and move a tall turn out of the virtual window. Anchor selection now requires viewport intersection. The same detached-control failure reproduced locally against the previous bundle; the amended Electron scenario passes with the fix. Existing following-row anchoring and keyboard navigation checks also pass.
- Windows x64: `usage-limits.spec.ts` tried to click a quota notice as its normal lifetime ended. Its native and hub fixtures also advanced reset timestamps on every request, changing notice identity. The fixture now shares a stable observation time and waits for normal notice expiry before layout captures. Quota notice behavior is not suppressed or changed.

## Bundle accounting

The baseline and implementation use the identical dependency graph. The necessary reference ownership/hydration guards add 1,032 bytes to each initial route. Preview feedback and the expansion correction bring the total core addition to 1,186 bytes. Only these exact measured additions were added to exceeded ceilings, retaining their previous headroom. All other ceilings and static-import assertions remain unchanged. See `renderer-bundle.json` for every measured metric.

## Verification

- `npm run check`: passed; 868 test files passed, 16 skipped; 9,232 tests passed, 145 skipped. Workflow policy, immutable migrations, architecture, color themes, both lint layers, all TypeScript targets, production builds and bundle budgets passed.
- `npm run test:portable`: passed; 99 files, 1,384 tests passed, 9 skipped.
- Focused corrections plus Git fixture recheck: 114 tests passed.
- Electron: `npx playwright test tests/e2e/quiet-ledger.spec.ts tests/e2e/usage-limits.spec.ts tests/e2e/transcript.spec.ts tests/e2e/conversation-context.spec.ts --project=display-sensitive --workers=1 --repeat-each=2`: all 8 runs passed on the final production build (1.5 minutes).

Native Windows x64 and Linux ARM64 jobs cannot be run on this macOS ARM64 host. The failed job logs and Linux trace were inspected, and their scenarios are exercised locally. Live authenticated provider sessions and packaged builds were not exercised; provider fixtures remain deterministic and secret-free.

One earlier full-suite run timed out while a Git test fixture created 1,000 refs during a concurrent comparison build; the isolated Git suite and focused corrections passed afterward (114 tests). The final gate passed without that competing build.

## Changed files on this branch

- `docs/pr-evidence/post57-corrections/renderer-bundle.json`
- `docs/pr-evidence/post57-corrections/review.md`
- `scripts/check-renderer-bundle.mjs`
- `src/renderer/src/components/composer/Composer.tsx`
- `src/renderer/src/components/composer/ComposerConversationContextCards.tsx`
- `src/renderer/src/components/composer/ComposerInputZone.tsx`
- `src/renderer/src/components/composer/useComposerConversationContext.tsx`
- `src/renderer/src/components/response-timeline/viewport.tsx`
- `src/server/persistence/bounded-message-text.ts`
- `src/server/persistence/continuation-history.ts`
- `src/server/persistence/conversation-context-packet-repository.ts`
- `src/server/persistence/conversation-context-source.ts`
- `src/server/persistence/conversation-context-transport.ts`
- `src/server/provider/claude-agent-sdk-harness.ts`
- `src/server/provider/claude-delegate-lifecycle.ts`
- `src/server/provider/claude-owned-query.ts`
- `src/server/runtime/conversation-context-service.ts`
- `tests/e2e/quiet-ledger.spec.ts`
- `tests/e2e/support/markdown-controls.ts`
- `tests/e2e/usage-limits.spec.ts`
- `tests/renderer/composer-chat-references.dom.test.tsx`
- `tests/server/claude-delegate-lifecycle.test.ts`
- `tests/server/claude-resume-queued-prompt.test.ts`
- `tests/server/claude-transport.test.ts`
- `tests/server/claude-update-continuity.test.ts`
- `tests/server/conversation-context-packets.test.ts`
