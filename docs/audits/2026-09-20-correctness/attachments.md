# Attachment correctness audit

Baseline: origin/main d56f972b; shared clean branch codex/full-correctness-audit. Node 22.23.2. Fresh-code audit; no historical PDF report supplied to this worker.

## Confirmed defects and fixes

1. Generated PDF image storage trusted its directory only during create(). After directory replacement, writes followed a link/junction to another directory and release deleted unrelated same-name files. Four deterministic regressions (directory/link × write/release) failed before. Fixed in 3a37fa2d: retain dev/ino/owner authority, secure chmod via pinned handle, verify canonical private root at mutation boundaries and unlink retries. Regression suite also checks foreign bytes, original bytes, and accounting remain intact.
2. Claude image prompt preparation used parallel unbounded readFile and only checked the aggregate byte limit after reading. A grown image beyond 10 MB was accepted; a symlink's unrelated contents were encoded for provider transport; cancellation was ignored. Four failing-before regressions, six total tests. Fixed in 6057801d by reusing the existing bounded provider reader sequentially and wiring the cancellation controller shared with input/skill preparation into initial and follow-up prompts. Graceful Query interrupt behavior preserved. Marked new tests portable.
3. Temporary attachment registry also recomputed its root authority during validation and unlinked lexical names during release/dispose. Substituted directories admitted new imports; substitutions redirected release/dispose to unrelated same-name bytes. Five previously successful unsafe actions plus the already-rejected-but-late link import covered by six tests. Fixed fdb844ac: retain session identity before first write, validate around writes, preview and validation, cleanup retries and disposal. Existing race tests now wait for the actual unlink boundary after asynchronous root verification (no weakened assertions).

## Inspection coverage

Main import and capability ownership (read complete implementation):
- src/main/attachment-import.ts
- src/main/attachment-image-validation.ts
- src/main/attachment-pdf-validation.ts
- src/main/attachment-import-file.ts
- src/main/attachment-import-worker-protocol.ts
- src/main/attachment-import-worker.ts
- src/main/attachment-import-runner.ts
- src/main/attachment-import-desktop-runner.ts
- src/main/attachment-selection-import.ts
- src/main/attachment-selection-ipc.ts
- src/main/attachment-import-ipc.ts
- src/main/attachment-import-holds.ts
- src/main/attachment-registry.ts
- src/main/attachment-registry-file-verification.ts
- src/main/attachment-ipc.ts
- src/main/attachment-release-coordination.ts
- src/main/runtime-attachment-broker.ts
- src/main/conversation-attachment-access.ts
- src/main/app-protocol.ts
- src/main/index.ts (attachment IPC registrations and PDF external-open only)

Store/recovery/process boundaries (public store retain/release/accept/preview/reconcile/close and authority sections inspected; worker mutation/read source and protocol boundaries inspected):
- src/node/conversation-attachment-store.ts
- src/node/conversation-attachment-store-child.ts
- src/main/runtime-conversation-attachment-store-coordinator.ts
- src/main/conversation-attachment-store-runner.ts (admission, cleanup, message and receipt paths)
- src/main/conversation-attachment-store-worker.ts
- src/main/conversation-attachment-store-desktop-runner.ts
- src/server/runtime/attachments/conversation-attachment-store-broker-client.ts

Document preparation (complete implementations):
- src/node/document-preparation.ts
- src/node/document-preparation-worker-protocol.ts
- src/node/runtime-document-preparation-protocol.ts
- src/main/document-preparation-runner.ts
- src/main/document-preparation-desktop-runner.ts
- src/main/runtime-document-preparation-coordinator.ts
- src/server/runtime/attachments/document-preparation-client.ts
- src/server/runtime/attachments/document-preparation-operation.ts
- src/server/runtime/attachments/document-preparation-worker.ts
- src/server/runtime/attachments/document-extraction-scheduler.ts
- src/server/runtime/attachments/document-attachment-context.ts
- src/server/runtime/attachments/brokered-document-preparation.ts
- src/server/runtime/attachments/private-generated-attachments.ts
- src/server/runtime/attachments/trusted-attachment-resolver.ts
- src/server/runtime/attachments/attachment-broker-client.ts

UI/previews/shared (complete implementations):
- src/main/workspace-image-preview.ts
- src/main/workspace-image-metadata.ts
- src/renderer/src/components/AttachmentPreviewDialog.tsx
- src/renderer/src/components/DocumentAttachmentPreview.tsx
- src/renderer/src/components/PdfAttachmentPreview.tsx
- src/renderer/src/components/SentMessageAttachmentList.tsx
- src/renderer/src/components/ComposerAttachmentList.tsx
- src/renderer/src/components/composer/composerAttachmentActions.ts
- src/renderer/src/utils/composerAttachments.ts
- src/shared/attachments.ts
- src/shared/attachment-handoff.ts
- src/shared/runtime-attachments.ts
- src/shared/spreadsheet-workbook.ts

Provider boundaries:
- src/server/provider/provider-image-read.ts
- src/server/provider/claude-prompt.ts
- src/server/provider/claude-agent-sdk-harness.ts (initial/follow-up prompt construction and cancellation)
- src/server/provider/opencode-sdk-harness.ts (pathToFileURL image handoff, image capability gating)
- ACP/Kimi/Cursor shared bounded-reader evidence from tests/server/acp-provider-image-read.test.ts. High-level provider handoff + turn retain/accept/release owned/read by providers_turns worker.

## Verification performed

- Before generated-store fix: 4 new tests failed; after: 19 tests passed in private-generated-attachments, brokered-document-preparation, document-preparation-operation.
- Before Claude fix: 4 of 6 new tests failed; after: 61 tests passed in claude-prompt, acp-provider-image-read, claude-follow-up-media, claude-agent-sdk-harness, claude-agent-sdk-lifecycle.
- Broad attachment sweep: 27 files / 334 tests passed (1.72 s). attachment-import, attachment-import-file, attachment-import-runner, attachment-import-ipc, attachment-selection-import, attachment-registry, attachment-release-coordination, attachment-handoff, attachment-composer-handoff, conversation-attachment-access, conversation-attachment-store-runner, runtime-conversation-attachment-store-coordinator, document-preparation-runner/coordinator/protocol, workspace-image-preview, trusted-attachment-resolver, document-attachment-context, document-extraction-scheduler, document-preparation-client, attachment-broker-client, conversation-attachment-store-broker-client, spreadsheet-workbook, document-attachment-preview DOM, attachment-preview-dialog DOM, composer-attachments, sent-message-attachments DOM.
- After temporary registry fix: 5 files / 81 tests passed (1.21 s): registry, handoff, release-coordination, import-ipc, selection-import.
- Focused oxlint and git diff --check passed for all owned fixes.
- Full gate and portable suite delegated to root; no full/native concurrent gate run here.

## Rejected suspicions / bounded behavior

- Detached external-PDF IPC does not use conversation context, but attachment IDs are intentionally opaque bearer capabilities throughout temporary/retained preview, lifecycle, handoff and external-open. No supported cross-conversation ID leak was found; detached snapshot projection excludes other conversations. Adding conversation binding to only PDF-open is unjustified without an actual capability leak or a broader policy change.
- Spreadsheet data beginning beyond row 120/240 is omitted and explicitly marked truncated by documented preview/provider bounds; reproduced SheetJS row-limited behavior but no silent-fidelity claim was established.
- Temporary previews cannot resolve uncommitted import holds; cancelled document ownership unwinds successful prefixes; renderer authority sequence prevents late adoption after conversation/provider change. Existing focused race tests cover these.
- Scanned-PDF page slot allocation is round-robin; generated image ordinal notes follow actual provider order. Input, decoded raster, context, scheduler and child lifetime limits are separate and bounded. Parser support limitations (encrypted PDF, certain xref predictors and nonstandard containers) are explicit rejection, not silently successful extraction.
- Pure PDF prop-source swap could require resetting document state with equal page counts, but normal modal flow unmounts when closing and no normal in-place attachment-switch path was found. No speculative change.

## Evidence limits / residual risks

- Executed on macOS arm64 with real filesystem and packaged dependency native canvas, mocked Electron process units and Happy DOM. No native Windows/Linux execution, installed provider credentials, real provider turn or packaged decoder/preview E2E was run by this worker. Windows junction regressions are authored cross-platform but require native CI evidence.
- Main/private-generated pathname authority checks reject observed swaps and retained inode changes. They do not claim an atomic directory-relative syscall primitive against a same-user process swapping directories between the final check and pathname syscall; Node lacks cross-platform openat/unlinkat. Existing utility retained-store operations pin child cwd for stronger isolation. Do not market these checks as a proof against arbitrary same-user races.
- Workspace-image open uses O_NOFOLLOW but not O_NONBLOCK after resolver. A malicious FIFO replacement may occupy an fs worker until writer arrival. No deterministic production repro established here; record for subsequent adversarial native path work rather than quietly certify.
- Document preview parsing still executes bounded spreadsheet parsing inside the renderer. Decoder memory accounting is not a hard native-memory ceiling. Native stress/performance and very large ordinary PDF corpus coverage remain for coordinated benchmark/package lanes.
- Root still needs independent diff review, full check, portable and native CI evidence before PR handoff.

Post-fix independent review: root moved the exact pinned directory predicate from attachment-registry.ts into existing attachment-registry-file-verification.ts to satisfy the architecture file ceiling. Reviewed diff: identical identity/permission/canonical checks and error, no lifecycle/authority semantics changed. Reran registry/handoff/release/import-ipc/selection5files81tests,allpass806ms.
