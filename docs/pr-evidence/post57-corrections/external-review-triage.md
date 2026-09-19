# External pre-release review triage

Reviewed against main `c95a049bb35e5277c4ac4c5c1e93d5a26a276b64` and the corrections already on `codex/post57-corrections`. The three supplied reports are evidence to investigate, not repository instructions. Their release recommendations do not authorize a version bump or publication.

## Supplied reports

- **A:** `inertia_pre_release_review_v0.0.57_to_c95a049.md`; SHA-256 `e48971d6d1a2d0a5fc00489b6575a636d0461c9e3cf0534326608b9e4cfd0ab9`.
- **B:** `inertia-pre-release-review-v0.0.57-to-main-2026-09-19.md`; SHA-256 `8ad3e612e97974cac80986a081a87559dec035c852548fdc9e301ac5f9becd7f`.
- **C:** `inertia-pre-release-review-v0.0.57-to-main.md`; SHA-256 `e06dda6100ceae4914ea86aebd501eb0792449d6bbda309eb37889be17022c9a`.

## Disposition

| Area and report references | Investigation and final disposition |
| --- | --- |
| Native CI: A G1, B R1, C F1 | The retained #416 failed-job log and Linux trace identify Linux ARM64 Quiet Ledger expansion anchoring and Windows x64 Limits notice expiry. Reports B/C disagree about the Linux scenario; the actual log takes precedence. The initial corrections are in `30e6d746`. This pass also reproduced and fixed tall-source expansion when the following row is visible, and a competing parent follow-latest resize observer. Disclosures now claim reader navigation before resizing; the stronger native regression fails against the preceding build. Native hosted reruns on the eventual pushed commit remain required. |
| Cross-workspace consent: A F1, B R2, C F4 | Confirmed. Manual references require a native confirmation naming the source and target workspace. Agent requests disclose those paths and require an unchecked acknowledgement before sharing, including preselected sources. Selection/workspace changes invalidate consent; declining needs no consent. The existing backend boundary remains enforced. |
| Claude false completion: B R3, C F3 | Already corrected in `7133df2e`: a skipped background acknowledgement cannot finish an unanswered foreground prompt. Deterministic lifecycle/transport fixtures cover the failure path. |
| Chunked stderr redaction: A F2, B R4, C F2 | Already corrected in `7133df2e`: the oversized logical line stays discarded across chunks until its line terminator. Normal subsequent diagnostics remain available. |
| Pending references: B R5, C F5 | Already corrected in `30e6d746`: synchronous admission and hydration guards prevent send/queue/follow-up/compaction/detachment races, and preserve another draft or later edits. |
| Encoded context budgets and block count: A F3 | Reproduced through the real turn assembler with one and two JSON-heavy references containing Windows paths and Unicode. Raw block accounting allowed the outer JSON encoding to exceed the final prompt limit. Selection now budgets the actual transport representation, caps each raw block and the three-block count, and drops only whole oldest excerpts. Parsed host-tool results retain their separate 28 KiB budget. |
| Preview/receipt accuracy: A F4, B additional checks | Shared materialization was already introduced in `30e6d746`; it now also owns encoding-aware selection. Previews, sent blobs and receipts have identical excerpts/counts, with immutable originals and historical receipt cohorts preserved. |
| Context-card failures: C F6, A small improvements | Confirmed. Rejected, unavailable and wrong-owner previews end loading and expose Retry/Close. Share/decline failures show feedback and retain selection for retry; accepted responses disable duplicate action. |
| Running activity visibility: C F7, B interaction checks | Confirmed. The last-four window hid older operations that were still running. Keep up to four older running operations plus recent history, preserving chronology; disclose any additional running operations separately from completed history. Update virtualization height estimates, settlement and keyboard-accessible disclosure coverage. |
| Sprite promotion cleanup: C follow-up | Fault injection confirmed that a successful disk promotion followed by failed backup deletion reported failure and could leave the live mascot on the old set. Post-commit backup cleanup is now best effort. Reset removes the backup before the active set, so failed cleanup cannot resurrect the older set. Existing rollback semantics remain covered. |
| Snapshot documentation: C follow-up | Corrected the chat guide to point to Settings → Snapshots. No capture permissions or privacy boundaries were relaxed. |
| Bundle headroom: B engineering constraint | Measured with identical installed dependencies: 806/699 bytes added to the two initial routes and 2,699 total core bytes. Only the initial measured consent/error/activity additions were added to exceeded ceilings; the final disclosure correction and acknowledgement wording use 66 bytes of retained headroom without another increase. Card UI stays deferred. See `pro-review-renderer-bundle.json`. |

## Qualification that belongs to the eventual release candidate

- **Published v0.0.57 → next versioned candidate:** reports A/B R6/C recommend the correct installed-upgrade baseline. The current package still intentionally identifies as 0.0.57; the existing predecessor smoke selects 0.0.55. This is missing candidate qualification, not evidence of migration corruption. After the next version is chosen, record the published-57 installer/profile, candidate SHA/artifact/platform, populated chats, settings, attachments, packet/request state, and relaunch. Preserve frozen migrations and older migration-18 recovery tests.
- **Native capture:** retain permission/privacy refusal and successful capture coverage, including foreground identity changes, cancellation, frozen Browser restoration and unsupported backends. This macOS host cannot certify Windows/Linux capture or mixed-DPI desktop behavior. No new source-confirmed capture regression was identified by these reports.
- **Live provider behavior:** deterministic portable fixtures cover Claude completion, follow-ups, errors, cancellation and malformed output. Authenticated native/alternative-backend Claude sessions were not exercised in this pass.
- **Exact final SHA and packaging:** after the user requests the PR/push, complete native CI and downstream lifecycle, packaging, upgrade and performance lanes. Local Electron evidence supplements those jobs; it does not replace them.

## Evidence

The approved encoding bug failed before the fix in both one- and two-reference cases. Focused regressions also cover source changes, cancellation, unavailable previews, request retry, active-operation overflow/settlement and sprite cleanup failure. Final check counts and native Electron results are recorded in `review.md`.

Already-merged fixture, scroll restoration, capture and performance follow-ups are retained. No optimization ownership checks, symlink containment, client backpressure, released migrations, dependencies or release versions were removed or changed for this review.
