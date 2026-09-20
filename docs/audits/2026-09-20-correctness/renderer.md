# Renderer correctness audit

This domain review records its review-wave evidence. The [consolidated audit](../2026-09-20-correctness.md) contains final local gates, native results and limitations.

Baseline: origin/main d56f972b. Shared worktree codex/full-correctness-audit. Node22.23.2. Continuation after attachment domain audit; native slots reserved for root.

## Confirmed issue: four-pane subscription identity

The existing split UI supports primary/secondary/tertiary/quaternary. Every non-primary useConversationProjection inferred secondary, while command schema, renderer reconnect tracker, URL encoder/parser and runtime hub recognized only two owners. Third/fourth mounted panes overwrote each other's detail subscription. Reconnect encoding additionally kept only the last two IDs, dropping primary/secondary. Five regressions failed before the fix across hook DOM, renderer tracker, schema and reconnect replay (one test fixture initially used id instead of requestId; corrected and rerun confirmed schema rejection of tertiary).

An additional event-order regression reproduced loss after a reconnect with a vacant middle pane: compact ID lists remapped tertiary to secondary. An immediate secondary cleanup then filtered the still-visible tertiary stream to runtime.cursor; conversely later re-registration could leave a ghost subscription in the vacant owner. The failing-before hub regression confirms the lost visible event.

Fix uses one shared bounded four-owner array, explicit projection owner from split scene, four-owner runtime/reconnect state and optional paired conversationOwner URL values. Exact owner labels survive vacant primary/middle owners and duplicate conversation ownership. Parser rejects unknown/repeated owners, mismatched pairs, over-four IDs and invalid IDs; old ID-only reconnect URLs remain supported. Detached authority ignores claimed owner/foreign IDs and remains restricted to its one conversation. No preload expansion.

Changed production files:
- src/shared/runtime-detail-subscriptions.ts (new canonical four-owner contract)
- src/shared/contracts/client-command/app.ts
- src/server/runtime-sequencing.ts
- src/server/runtime/runtime-sync-hub.ts
- src/renderer/src/utils/runtimeSequencing.ts
- src/renderer/src/hooks/useInertiaConnection.ts
- src/renderer/src/hooks/useConversationProjection.ts
- src/renderer/src/hooks/useSplitWorkspaceScene.ts

Changed tests:
- tests/server/runtime-sequencing.test.ts
- tests/server/runtime-sync-hub.test.ts
- tests/renderer/runtime-sequencing.test.ts
- tests/renderer/conversation-projection-interactions.dom.test.tsx

## Read inventory

Complete implementation reads (except explicitly noted portions):
- src/renderer/src/hooks/useStreamingAgentState.ts
- src/renderer/src/hooks/usePlanSteps.ts
- src/renderer/src/hooks/useSplitPanes.ts
- src/renderer/src/hooks/useSplitPaneScenes.ts
- src/renderer/src/hooks/useSplitWorkspaceScene.ts
- src/renderer/src/hooks/useDraftConversation.ts
- src/renderer/src/hooks/useDetachedChatWindows.ts
- src/renderer/src/hooks/useDocumentPresence.ts
- src/renderer/src/hooks/useConversationProjection.ts (subscription, hydration, terminal projection, request-generation, resets; large event switch read in earlier chunks)
- src/renderer/src/hooks/useInertiaConnection.ts (socket admission/reconnect/subscription tracking and command boundary)
- src/renderer/src/components/composer/useComposerDetachmentOwnership.ts
- src/renderer/src/DetachedChatApp.tsx
- src/renderer/src/components/ChatWorkspace.tsx (streaming adapter, navigation/scroll/effect ownership and rendered timeline/composer boundaries)
- src/renderer/src/components/response-timeline/viewport.tsx
- src/renderer/src/components/response-timeline/final-answer-anchor.ts
- src/renderer/src/utils/splitLayout.ts
- src/renderer/src/utils/splitConversation.ts
- src/renderer/src/utils/draftConversationPersistence.ts
- src/renderer/src/utils/composerDraftPersistence.ts
- src/renderer/src/utils/composerOwnership.ts
- src/renderer/src/utils/modalFocus.ts
- src/renderer/src/utils/workspacePreviewFocus.ts
- src/renderer/src/utils/transcriptPosition.ts
- src/renderer/src/utils/transcriptNavigation.ts
- src/renderer/src/utils/runtimeSequencing.ts
- src/shared/contracts/client-command/app.ts (subscription schema and imports)
- src/shared/desktop.ts (preview owner contract; no source edit)
- src/server/runtime-sequencing.ts
- src/server/runtime/runtime-sync-hub.ts
- src/server/runtime/runtime-client-authority.ts
- src/server/runtime/detached-chat-runtime-policy.ts
- tests/renderer/streaming-render-isolation.dom.test.tsx
- tests/renderer/conversation-projection-interactions.dom.test.tsx (fixture, subscription and hydration tests)
- tests/server/runtime-sync-hub.test.ts
- tests/server/runtime-sequencing.test.ts
- tests/renderer/runtime-sequencing.test.ts

## Focused verification

37 test files /348 tests passed in three focused batches (no full or native parallel gate):

Subscription/integration batch:10 files/112 tests,6.52s:
- tests/renderer/runtime-sequencing.test.ts
- tests/server/runtime-sync-hub.test.ts
- tests/server/runtime-sequencing.test.ts
- tests/renderer/conversation-projection-interactions.dom.test.tsx
- tests/server/detached-chat-runtime-authority.test.ts
- tests/server/detached-runtime-websocket.test.ts
- tests/renderer/inertia-connection.dom.test.tsx
- tests/renderer/inertia-connection-parser-recovery.dom.test.tsx
- tests/renderer/conversation-split-view.dom.test.tsx
- tests/renderer/split-pane-storage.dom.test.tsx

Broader renderer batch:19 files/167 tests,2.11s:
- tests/renderer/streaming-render-isolation.dom.test.tsx
- tests/renderer/draft-conversation.dom.test.tsx
- tests/renderer/detached-chat-windows.dom.test.tsx
- tests/renderer/detached-chat-leaf-ui.dom.test.tsx
- tests/renderer/detached-conversation-actions.dom.test.tsx
- tests/renderer/dismissible-menu-focus.dom.test.tsx
- tests/renderer/subagent-timeline-focus.dom.test.tsx
- tests/renderer/message-search-focus.dom.test.tsx
- tests/renderer/timeline-item-focus.dom.test.tsx
- tests/renderer/workspace-preview-focus.dom.test.tsx
- tests/renderer/split-layout.test.ts
- tests/renderer/split-conversation.test.ts
- tests/renderer/split-drop.test.ts
- tests/renderer/response-timeline.test.ts
- tests/renderer/response-timeline-virtualization.test.ts
- tests/renderer/timeline-estimate-layout.dom.test.tsx
- tests/renderer/timeline-minimap.dom.test.tsx
- tests/renderer/quiet-ledger-streaming-answer.test.ts
- tests/renderer/accessibility-focus-policy.test.ts

Ownership/navigation batch:8 files/69 tests,1.28s:
- tests/renderer/composer-ownership.dom.test.tsx
- tests/renderer/final-answer-identity.test.ts
- tests/renderer/transcript-composer-composition.test.ts
- tests/renderer/chat-workspace-final-answer-hydration.dom.test.tsx
- tests/renderer/transcript-navigation.test.ts
- tests/renderer/final-answer-document.test.ts
- tests/renderer/transcript-turn-anchor-phase.test.ts
- tests/renderer/transcript-turn-anchor.dom.test.tsx

Focused oxlint and git diff --check pass. Parent owns complete check and portable gates.

## Performance evidence and rejected suspicions

Executed streaming-render-isolation DOM test measures 200 sequential token events after quiet hydration:200 React commits,200 ResponseTimeline and TurnTimeline renders,zero App/AppLayout/Sidebar/WorkspaceHeader/WorkspaceScene/ChatWorkspace/Composer renders. This is actual deterministic render-count evidence, not native latency/fps/memory measurement. Composer typing test also verifies background shell render isolation.

- Streaming selection hook has an equal-snapshot shortcut that can preserve an old selection if callers change their selector with an unchanged source snapshot. Current two call paths use stable module-level selectors (identity and running plan steps), so no reachable user defect was confirmed. Source replacement renders the new snapshot immediately and effect catches pre-subscribe changes; no source-swap production failure reproduced. No speculative source change.
- Draft handoff prevents transferring unowned attachments, unresolved model routes or in-flight mutations. Detached beforeunload persists the exact current draft synchronously and blocks on failure; explicit dock/close surfaces privileged failures. Registry cleanup uses owner equality to avoid StrictMode stale cleanup removing a newer owner.
- Timeline anchor restoration has separate owner/cancel paths for final answer, accepted turn and layout. Accepted-turn missing-row settling stops scheduling after30 attempts but can wait for subsequent observer mutation; no finite successful hydration case shown stuck. Expansion frame callbacks are bounded; conversation changes use unique row IDs. These paths need real geometry evidence for stronger guarantees.
- src/shared/desktop.ts PreviewStateUpdate still names only primary/secondary, while actual native preview paths use wider owner types. No runtime rejection found from this type-only declaration; avoid unrelated API widening without concrete reproduction.

## Evidence limits

HappyDOM establishes state/effect/focus behavior and render counts, not native layout fidelity, keyboard OS routing, actual scroll/virtualization geometry, GPU/paint times or detached BrowserWindow IPC wiring. Native E2E, packaged behavior and benchmark lanes remain coordinated by root. Windows/Linux native execution and real provider runtime are not claimed. No changes to snapshot matching already merged in #430.

Committed renderer fix:23893a8d (12 files,8 production/4 tests;262 insertions/34 deletions). Independent providers_turns review requested. Source stable for root full gate.

Bundle follow-up: root full check passed quality+9412 tests but failed renderer bundle budgets by100–200bytes. Committed d7a94605 (3files,1production/2tests): removed now-unused renderer conversationIds() and test-only legacy string-input URL branch; production ownerpair URLs and server legacy URL compatibility preserved. Updated fixtures to actual paired API. Focused5files63tests pass1.38s (renderer sequencing,server sequencing,hub,connection,parser recovery),focused lint/diffcheck pass. Providers_turns independent review says safe/no blocking findings. No budget increases, rebuild/native/broad runs by this worker; root owns bundle retry.

Second bundle follow-up: d7a94605 fixed detached budget, but root measured main40bytes/core138bytes above unchanged ceilings. Committed77745385: Map keeps only mounted owner objects; hook owner uses equivalent declared-type destructuring default; shared MAX4 has the owner tuple's literal length type so a tuple-size change must update it. Renderer imports only numeric limit, server enum/validation unchanged. Added tests for noncanonical mount/reopen order with duplicate conversation ownership and explicit4pair URL bound.89focusedtests6files pass1.51s; lint/diffcheck pass. Providers independently approved Map/default semantics. No build/native/broad runs by this worker; root owns final byte verification.
