# Chat input and continuity review

This change handles the confirmed Inertia behaviors from the chat-input request in one branch. It does not publish a release or change a version.

## Behavior and boundaries

- Remove the Skills toolbar button. Typing `$` opens discovery and suggestions at the editor, including loading, failure, refresh and no-match states. Arrow keys select, Enter/Tab insert, Escape dismisses, and selecting inside a token replaces the complete token while preserving surrounding prose. Keyboard selection scrolls the active suggestion into view.
- Apply the existing border animation to the selected model's highest advertised, recognized reasoning level, regardless of provider or catalog ordering. An unavailable model or arbitrary variant is not treated as maximum reasoning. Reduced-motion and hidden-document rules remain in place.
- Retain quota notification history when startup metadata omits a previously known reset time, or learns the reset time after an initially unknown value. Lower thresholds and a real reset still notify.
- Preserve an anchored reading position when changing chats in the same window. Memory holds at most 100 conversation identities and geometry, without copying transcript text or writing to disk. Virtualizer/hydration scroll events do not cancel following without reader intent. Jump to latest and a new submitted turn intentionally leave the saved historical position.
- When a verified native Claude installation change invalidates its session, attach bounded visible history from the same conversation to the fresh request. This does not reuse an incompatible session. It is limited to the latest 24 user/assistant messages, 4 KiB per message, bounded chunk reads, and a 40 KiB serialized-message budget. Truncation and the recovered-reference label are recorded in the execution manifest. Recovery is included only when its complete serialized reference fits the remaining reference, segment and payload capacity; otherwise it is omitted without changing the selected request. Known secret patterns and control sequences are scrubbed. Attachments, tool output and hidden provider state are not reconstructed. Failed launch/restart retries retain the recovery only with the same verified continuation identity. Backend, endpoint, unverified and compatible-session boundaries are tested separately.

## Requested investigations not shipped as features

- Voice transcription is deferred under the user's explicit local-provider-only constraint. The installed Codex app-server schema exposes experimental realtime conversation/audio operations, not a standalone transcription contract with a safe review-before-send path. No external transcription service or new credential flow was added.
- The reported Codex line breaks could not be reproduced from the available description. The adapter appends exact text deltas, storage preserves the text, and the live renderer retains whitespace. Existing deterministic Codex/streaming tests pass. This PR does not strip Markdown/code newlines or claim to fix an unconfirmed provider-output issue.
- The Claude change addresses an identified Inertia session-invalidation path. A live authenticated provider upgrade was not performed, and this does not establish that every reported context-loss case has this cause.

## Evidence

- Node 22 `npm run check`: 856 files and 9,140 tests passed, 144 expected skips; architecture, lineage, themes, lint, types and production bundle gates passed.
- `npm run test:portable`: 96 files / 1,367 tests passed, 9 expected skips.
- Focused UI coverage: 142 passing tests for skills, editor lifecycle, provider maximums, quota persistence, navigation and reduced motion. Focused Claude/request-context suite: 25 passing tests, including retry after runtime restart and isolation boundaries.
- Real Electron on macOS ARM64 and Linux ARM64: both 4-turn and virtualized 80-turn A → empty B → A histories restore the same row and offset; Jump to latest still works. Existing long-transcript geometry, expansion, minimap and keyboard scenario passes on both platforms (3 scenarios per platform).
- Negative control: the same two navigation scenarios run against unchanged main `5aaaaac8` fail at the returned row identity. The implementation passes without relaxing the row/offset assertions.
- Existing transcript E2E scrolling now uses native wheel input rather than assigning `scrollTop`, so its reading-history assertions express actual reader intent.
- Linux ARM64 production build passes. Matching-dependency renderer measurements are in `renderer-bundle.json`: startup increases are 1,204 / 1,125 bytes; shared core decreases 6 bytes. Only the two initial route ceilings are adjusted with about 0.2 KiB headroom.
- Native Linux background-animation test passes, including foreground, visible-unfocused, resumed, and reduced-motion phases.
- Final Linux Electron run: 5 passing scenarios, including the three transcript cases, skills geometry with a deterministic workflow projection, and an additional cold-discovery probe through a synthetic local Codex control process. Native Electron skills geometry/insertion also passes on macOS with the deterministic workflow projection. A separate synthetic native-provider-discovery attempt hit macOS guardian cleanup failure; it is not claimed as passing evidence and no shutdown assertions were bypassed. Portable control/workflow tests remain the provider boundary coverage.
- Carry the already-reviewed four-line #405 test isolation fix: freeze only interval timers during the 200-token render-count assertion, then restore real timers after cleanup.
- Native background-animation testing on this macOS desktop cannot establish the resumed-focus phase: an isolated probe reports that the OS grants neither test window native focus. Assertions are retained; no focus-emulation bypass or platform skip was added. The fixture now advertises its selected maximum explicitly instead of relying on an unsupported saved reasoning string.

Windows-native behavior and hosted cross-platform CI must be confirmed on the PR. No live accounts, microphone recording, or provider upgrade were used for validation.

## Review follow-up: recovery capacity

The review identified that automatically adding history could reject a previously valid request. The assembler now validates the selected request first, then includes recovery only when the complete reference fits all three existing limits. Byte accounting includes JSON escaping, UTF-8, framing, internal instructions and image references. If recovery does not fit, the original selected request and its persisted manifest/blobs remain unchanged. Over-limit selected requests still fail validation; limits are not increased.

The corrected source also passes the full Node 22 gate (9,140 tests).

Three regression scenarios reproduce reference, segment and payload failures on `590e3c7f` (10 existing request-context tests passed; all 3 new tests failed). They pass after the repair, together with the existing Claude continuity tests: 2 files / 20 tests. The payload case checks exact-fit inclusion, one-byte overflow omission, a completely full selected request, and rejection when the selected request itself exceeds the limit.

## Changed files

- `docs/pr-evidence/chat-input-and-continuity/renderer-bundle.json`
- `docs/pr-evidence/chat-input-and-continuity/review.md`
- `docs/user/chats-and-agents.md`
- `scripts/check-renderer-bundle.mjs`
- `src/renderer/src/components/ChatWorkspace.tsx`
- `src/renderer/src/components/composer/Composer.tsx`
- `src/renderer/src/components/composer/ComposerInputZone.tsx`
- `src/renderer/src/components/composer/ComposerSkillsMenu.css`
- `src/renderer/src/components/composer/ComposerSkillsMenu.tsx`
- `src/renderer/src/components/composer/useComposerMenus.ts`
- `src/renderer/src/components/composer/useComposerSkillCompletion.ts`
- `src/renderer/src/components/response-timeline/viewport.tsx`
- `src/renderer/src/hooks/useDismissibleMenu.ts`
- `src/renderer/src/styles.css`
- `src/renderer/src/utils/composerSkillToken.ts`
- `src/renderer/src/utils/maxReasoning.ts`
- `src/renderer/src/utils/quotaNotifications.ts`
- `src/renderer/src/utils/transcriptNavigation.ts`
- `src/renderer/src/utils/transcriptPosition.ts`
- `src/server/database.ts`
- `src/server/persistence/continuation-history.ts`
- `src/server/persistence/transcript-repository.ts`
- `src/server/runtime/turns/request-context.ts`
- `src/server/runtime/turns/turn-request-preparation.ts`
- `tests/e2e/chat-scroll-memory.spec.ts`
- `tests/e2e/composer-skills.spec.ts`
- `tests/e2e/renderer-background.spec.ts`
- `tests/e2e/transcript.spec.ts`
- `tests/renderer/chat-workspace-turn-anchor.dom.test.tsx`
- `tests/renderer/composer-lifecycle.dom.test.tsx`
- `tests/renderer/composer-skill-token.test.ts`
- `tests/renderer/composer-skills-menu.dom.test.tsx`
- `tests/renderer/max-reasoning.test.ts`
- `tests/renderer/quota-notifications.test.tsx`
- `tests/renderer/streaming-render-isolation.dom.test.tsx`
- `tests/renderer/transcript-navigation.test.ts`
- `tests/renderer/visual-contrast.test.ts`
- `tests/server/claude-update-continuity.test.ts`
- `tests/server/request-context.test.ts`
