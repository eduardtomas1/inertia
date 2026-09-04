# Changelog

The useful changes in each Inertia release, in plain language.

## Next

## 0.0.48 — 2026-09-04

### Updates and attachment-backed messages settle reliably

- After a Linux AppImage update or remount, startup can retire the exact prior
  runtime generation even when the newly installed guardian has a different
  executable inode. Recovery still proves the prior PID, birth identity,
  process group, session, stopped state, and absence of children before
  termination, and releases the durable claim only after disappearance is
  confirmed.
- Attachment retention, attachment import, and secure-file utility operations
  now correlate terminal results with an operation UUID and wait for the
  parent's exact acknowledgement before exiting. This prevents a valid result
  from being lost to an IPC/exit race and aborting a prompt with
  `message-send/retention/unexpected`.
- Missing, mismatched, duplicate, pre-delivery, or undeliverable
  acknowledgements remain fail-closed inside existing deadlines. Cancellation
  before a cold utility process spawns is retried at spawn, so a late helper
  cannot remain alive and poison subsequent prompts or runtime shutdown.

### Release confidence

- Regression coverage exercises AppImage replacement-helper recovery, durable
  claim clearance, strict one-shot worker correlation and acknowledgement,
  malformed and failed acknowledgement paths, pre-spawn cancellation, and
  repeated PNG-backed prompt sends in a real Electron non-Git workspace.

## 0.0.47 — 2026-09-03

### Messages and local work recover without an app restart

- Sending a normal prompt is now one atomic admission: a failed request rolls
  back its provisional turn and releases the conversation instead of leaving
  every later prompt blocked until Inertia is reopened.
- Startup and replacement retire stale runtime generations through bounded,
  platform-specific ownership proof. Transient Windows journal reads, Linux
  guardian publication, native probes, Git shutdown, and interrupted cleanup
  reconcile without treating uncertain processes as safe or spamming restart
  dialogs.
- Delegated continuations, one-shot provider actions, patch and command
  activities, and recovered turns settle against their exact run and item
  identities. Late events cannot keep a completed activity spinning or attach
  a failure to a newer turn.

### Providers stay current, bounded, and attributable

- Claude coalesced follow-ups retain every exact receipt, including queued
  media, while Codex delegation waits for its owned continuations. OpenCode
  descendant work remains project-isolated and its server identity is poisoned
  whenever shutdown cannot be confirmed.
- Provider discovery, validation, drift probes, output limits, and process-tree
  cleanup now share stricter executable and runtime boundaries. Diagnostic
  output remains available without consuming a provider's output allowance or
  weakening descendant cleanup checks.
- The reviewed provider contracts now target ACP 1.4.0, Claude Agent SDK
  0.3.259, Anthropic SDK 0.123.0, MCP 1.30.0, and OpenCode SDK 1.18.27, with
  secret-free drift checks and deterministic portable coverage for each
  shipped integration.

### Large and split workspaces stay responsive

- Git refreshes, pre-turn artifact capture, renderer projections, and shutdown
  drains are coalesced and bounded, avoiding duplicate process storms and long
  UI stalls while preserving exact repository and conversation ownership.
- Linked files open at the requested target and long previews virtualize their
  content. A new chat opened from the Inertia mark remains scoped to the active
  project, and provider settings use a clearer master-detail layout.
- Composer utilities, Skills, reasoning, response-speed, and scratch-prompt
  menus are positioned inside their active split pane instead of extending
  beneath the screen edge.

### Installed application names stay stable across updates

- Stable production packages keep the installed identity `Inertia` on macOS
  and Windows and `Inertia.AppImage` on Linux. Canary remains separate as
  `Inertia Canary` / `Inertia Canary.AppImage`, while development builds stay
  outside in-app delivery. Public release assets can remain versioned.
- A first in-app update from a manually downloaded versioned AppImage now
  migrates to the durable channel filename, and repeated updates preserve it.
  The Linux handoff validates direct files and realpath containment, copies the
  verified download into the active directory, swaps only within that
  directory, retains an inode-bound rollback link, and recovers interrupted
  transactions from a bounded journal.
- Focused coverage exercises first migration, unversioned and repeated
  updates, spaces and directory aliases, hostile symlinks and occupied paths,
  launch rollback, interrupted recovery, channel isolation, and all three
  platform identities. Native release-container smoke launches Linux through
  its installed filename while macOS and Windows retain their exact bundle and
  executable names.

### Release confidence

- Electron 44 packaging, macOS 13 compatibility, native x64 and ARM64 package
  paths, process containment, migration lineage, provider portability, and the
  exact-tag checksum and provenance boundary remain covered across Linux,
  macOS, and Windows.

## 0.0.46 — 2026-09-01

### Provider work recovers after ownership uncertainty

- When owned-process containment or cleanup becomes unconfirmable, the first registry taint now stops the local runtime once so the supervisor can replace it. Later provider and terminal requests no longer remain permanently fail-closed inside a poisoned runtime.
- Recovery is wired at the shared owned-process registry, so it covers Codex, Claude, Cursor, Kimi Code, and OpenCode as well as provider discovery, validation, metadata, maintenance, and run subprocesses. Non-run provider work receives the same recovery boundary as an active chat.
- Admission remains fail-closed before restart notification. Repeated taint signals are idempotent, stale or deactivated registries cannot restart the current runtime, and a failing notification callback cannot reopen process admission.

### Release confidence

- Integration coverage taints a provider subprocess outside an active run and proves the runtime notification fires exactly once. Provider coverage, both lint layers, type safety, architecture and migration checks, and the complete Linux, macOS, and Windows pull-request matrix remain green at the exact merged fix head.

## 0.0.45 — 2026-08-30

### The Browser is ready when the chat is

- The integrated Browser now starts from the owning chat without a separate warm-up action, works in existing conversations as well as new ones, and keeps the same visible local page available to both the user and the agent. Navigation, tabs, semantic inspection, interaction, and bounded evidence remain tied to the exact project, chat, run, turn, page, and capability authority.
- Provider harnesses can compose reviewed Inertia-owned capability packs without replacing their native transports. Deterministic manifests and frontend audits keep tool availability, instructions, evaluation boundaries, and Browser semantics attributable across Codex, Claude, Cursor, Kimi Code, and OpenCode.
- Editable labels, hidden content, image controls, accessible-name traversal, and opacity boundaries received adversarial coverage so semantic Browser actions remain useful without turning page-controlled content into trusted authority.

### Runtime crashes recover without asking for a reboot

- Windows binds each utility runtime to its exact Electron creation identity before assigning the native Job Object, so a slow PowerShell start cannot target a recycled PID. Admission remains inert until containment is ready and cancels cleanly on stop, process exit, or runtime replacement.
- Linux authenticates guardian completion against the durable owned generation, exact process identity, executable identity, and process group. macOS retries transient privileged census reads within a strict bound while preserving birth identities and fork taint; disappearance, PID reuse, cancellation, parent loss, and exhausted proof still fail closed.
- When macOS must preserve an owned login shell and start an action or provider in a distinct terminal, a delayed response now reconciles that replacement through its exact request identity. The original shell and requested process remain visible, attributable, and retryable instead of leaving a hidden terminal after an IPC timeout.
- Startup now retires only process trees it can prove belong to Inertia and reconciles interrupted runs truthfully. The normal desktop recovery path no longer tells users to restart the operating system. macOS continues to state its real platform limit: an arbitrary descendant that deliberately double-forks into a new session cannot be proven contained by an unprivileged app.

### Daily Work measures active time

- Work durations exclude time while the computer is suspended. Closing a laptop or letting the system sleep no longer inflates the duration of work that was already in progress, while ordinary active time and completed history remain unchanged.

### Native installation and release evidence match the package users receive

- Windows ARM64 installers use architecture-correct application archives and are installed, launched, package-smoked, and uninstalled on a native ARM64 runner. A reboot-success installer code is rejected rather than presented as a recovery strategy.
- macOS Intel and Apple silicon, Windows x64 and ARM64, and Linux x64 and ARM64 containers are checked through their final public package paths. Package-smoke receipts publish atomically.
- Version, migration lineage, architecture, both lint layers, all TypeScript projects, the complete unit and integration suite, portable provider contracts, real Electron recovery, production bundles, renderer budgets, native package smoke, Electron fuses, checksums, provenance, screenshots, and exact-head review remain release-blocking.

## 0.0.44 — 2026-08-25

### CI checks have clearer deterministic owners

- Source-control deadline coverage now advances a fake clock while preserving the production cancellation and cleanup contract. The exhaustive macOS partial-signing matrix runs in one bounded Node process, sidebar motion assertions wait for their exact lazy module to settle, and Agent Browser privacy checks run in a focused Electron scenario instead of extending the unrelated cross-project workspace test. These are test-harness reliability changes: production Git deadlines, signing policy, motion, and Browser privacy boundaries are unchanged.
- Browser evidence coverage now measures hostile-console sanitization against the owning thread's CPU budget and verifies every retained redaction and bounded ledger entry. The compact evidence control also has an explicit accessible name containing its current evidence count, so the audited state remains understandable without its hidden text label.
- The PTY lifecycle benchmark now keeps its fixture alive until all 2,000 ordered records cross the public terminal stream and an explicit acknowledgement returns through the product input path. Stream first-projection evidence retains three raw persistence-path samples, applies the existing catastrophic ceiling to each, and uses their median for the unchanged 75-millisecond shipped-cadence gate. These are benchmark-method changes: production terminal and streaming behavior are unchanged.

### Release confidence

- The detached-chat, composer-command, and Browser-evidence fixtures now assert their owned persisted state, route, accessibility, and teardown boundaries directly.
- Credential-free publication remains an exact 11-file union: four ad-hoc-signed macOS packages, two unsigned Windows installers, two Linux AppImages, two architecture-qualified Linux update manifests, and `SHA256SUMS.txt`. macOS and Windows remain checksum-first manual installs; only Linux AppImages support verified in-app delivery in this configuration.
- Version, release metadata, migration lineage, architecture, lint, type safety, unit and integration behavior, portable provider contracts, production dependencies, renderer budgets, package smoke, Electron fuses, checksums, provenance, and the exact-head release PR remain the publication boundary.

## 0.0.43 — 2026-08-25

### The complete 0.0.42 feature line reaches its first public binary

- Inertia 0.0.43 is the first published binary to contain the complete 0.0.42 feature set described below, together with the completed-answer anchor correction in this section. The `v0.0.42` tag was created, but its platform build never reached publication: there is no GitHub release and there are no downloadable 0.0.42 assets. The 0.0.42 entry remains the historical record of that feature batch; use 0.0.43 for installation.
- A newly completed answer now keeps its exact reading position while ordinary terminal and detail rerenders settle. The bounded anchor survives only for its matching conversation, turn, run, and answer lifecycle, cancels for explicit reader navigation or replacement work, and cannot let a loaded host pull the answer back to the bottom between its first and second stable frame.

### Release confidence

- The positive OpenCode manual-compaction boundary fixture now has enough test-only headroom to observe completion on loaded hosts, while the production 30-minute inactivity deadline and the focused 100-millisecond negative fixtures remain unchanged. Final-answer coverage reproduces terminal and detail rerenders between stable layout frames and verifies the result in a real Electron viewport.
- Version, release metadata, migration lineage, architecture, lint, type safety, unit and integration behavior, portable provider contracts, production dependencies, renderer budgets, package smoke, Electron fuses, checksums, provenance, and the exact-head release PR remain the publication boundary.

## 0.0.42 — 2026-08-25

### Agents can work in a visible, inspectable local Browser

- Each chat can own a hardened, non-persistent multi-page Browser for loopback development sites. Codex, Claude, Cursor, Kimi Code, and OpenCode can inspect a bounded semantic view, navigate, click, type, scroll, and switch pages through host-owned tools while the exact page remains visible in Inertia. Remote sites continue to open outside the embedded Browser, and Browser authority ends with the owning runtime.
- Browser work gains a bounded local evidence timeline for screenshots, console errors, failed requests, navigation, and visible agent actions. Evidence retains exact project, chat, tab, run, turn, document, and occurrence identity; providers receive bounded semantic snapshots and evidence metadata rather than screenshot pixels; and the complete ledger disappears when its Browser closes. A screenshot remains main-process-owned and opens only after exact post-capture approval in a no-preload native inspector that clears on replacement, navigation, eviction, or page closure.
- Evidence fails closed before a provider or renderer can inspect it when a document observes password data or content looks like a credential, private path, credential-bearing URL, malformed encoding, or oversized value. The Browser also revalidates the exact live target through interaction settlement so navigation, focus, nested controls, disabled geometry, and page-script races cannot redirect an acknowledged action.

### Provider and runtime state has one truthful owner

- Running, delegated, retrying, waiting, cancelling, failed, and completed states now come from one authoritative persisted run-state engine. Codex, Claude, Cursor, Kimi Code, and OpenCode settle renderer state with the owned provider process instead of leaving a stale “working” label after failure, interruption, retry, restart, or exit.
- OpenCode descendant sessions form a bounded verified ownership graph. Legitimate subagent work keeps its parent run alive without copying child-private reasoning or tool output into the parent conversation, unrelated sessions cannot extend the deadline, and the root session still decides final completion and cancellation.
- Provider protocol coverage was re-audited and refreshed for ACP 1.4, Claude Agent SDK 0.3.238, and OpenCode SDK 1.18.21. Supervised runtimes now preserve only bounded, reviewed non-secret Git, shell, terminal, WSL, desktop, locale, proxy, pager, Homebrew, Bedrock, and Claude cloud-routing state; credentials, auth selectors, loader controls, executable hooks, malformed endpoints, and arbitrary environment families remain excluded at both process boundaries.

### Files, attachments, and review surfaces stay attributable

- Files navigation is denser and more direct across trees, previews, nested repositories, language-aware links, searches, refreshes, and responsive panel sizes. Exact selected paths, repository ownership, keyboard focus, disclosure, and in-flight search state stay stable instead of being inferred from transient layout or stale reads.
- Picker, paste, and drop attachments now enter a privileged per-document batch lease before the renderer can preview or send them. Pending images do not fetch before acknowledgement, only the exact committed subset becomes provider-visible, and navigation, renderer loss, cancellation, timeout, partial failure, or stale chat/turn authority reclaims every uncommitted intermediate.
- The pre-merge confidence view brings exact-head CI, Codex review freshness, affected areas, focused and portability evidence, bundle deltas, and release readiness into one local surface. Theme contrast, borders, labels, menus, focus, and compact controls were also refined across every built-in palette without flattening the character of light, dark, split, detached, narrow, reduced-motion, or forced-color layouts.

### Recovery and first paint do less work without hiding failure

- Workspace ordering, traversal, streaming first paint, and high-frequency projections avoid redundant work while preserving exact ordering, focus, visible live state, architecture boundaries, and renderer budgets. Performance changes were retained only where measured behavior improved without weakening correctness.
- Recoverable database-family and startup state is quarantined and restored without presenting partial recovery as success. Desktop persistence and hosted evidence now synchronize exact fixture identity, streaming projection, transcript navigation, Files geometry, and Browser bounds without relaxing product deadlines or assertions.
- Updater and restart ownership recover deterministically, off-screen main and detached windows return to a usable display, and partial process, storage, or renderer health remains visibly partial. Node 22.13 is now validated as the minimum supported runtime instead of letting an older Node installation fail later with a less precise error.

### Native releases cover every supported architecture

- Stable release CI now builds and smokes native macOS Intel and Apple silicon, Windows x64 and ARM64, and Linux x64 and ARM64 packages on matching hosts. Exact-tag validation, locked dependencies, native-binary checks, the complete test gate, package smoke, Electron fuses, checksums, provenance, and no-replacement publication cover the full six-architecture union before one writer publishes it.
- Signing remains optional until the project has certificates. macOS uses its verified ad-hoc signature and Windows remains explicitly unsigned, so both platforms use a clear manual download flow; Linux AppImages retain their verified in-app delivery path. Stable feed metadata alone never grants updater authority—the verified packaged capability marker remains decisive—and a partial signing configuration fails closed without making unsigned public packages unusable.
- A separate Canary channel can validate prerelease packages without changing Stable’s latest feed, application identity, local profile, workspace state, updater cache, or protocol. Canary retains and re-verifies its last-known-good package for bounded rollback, while an immutable migration-lineage gate protects every released database migration and its relevant helpers from edits, removal, or reordering.

### Release confidence

- Reviewed dependency updates cover provider protocols, MCP, canvas, virtualization, icons, native SQLite types, and their locked transitive graph. Deterministic portable contracts continue to prove provider success, continuation, tools, images, compaction, failure, cancellation, malformed input, output ceilings, and clean shutdown without downloading unreviewed provider code during the release gate.
- Architecture and both lint layers, all TypeScript projects, the complete unit and integration suite, portable provider contracts, real Electron scenarios, production dependency audit, renderer budgets, migration lineage, native package smoke, Electron fuses, checksums, provenance, and the exact-head release PR protect the release.

## 0.0.41 — 2026-08-21

### Active chats stay compact while follow-ups remain deliberate

- The main and detached composers use the same tighter responsive surface, clearer type, restrained depth, and stable control geometry. Detached windows no longer carry a decorative Live badge, and accepted sends are expressed by truthful Send-to-Stop motion instead of a lingering status label.
- While an agent is running, Enter sends an immediate text follow-up and Tab places it in that chat's durable FIFO queue. Queued drafts survive reloads and detached-window moves, expose exact send-now and remove controls, and are not consumed by failed or cancelled turns.
- Typing `$` opens keyboard-accessible autocomplete for only the enabled skills discovered from the selected Codex or Claude route. Unknown names remain ordinary prompt text, and selection never exposes skill paths or contents to the renderer.
- Long conversations use a richer responsive minimap with a longer bounded rail, more stable nearby turns, and readable previews without mounting distant transcript detail.

### Daily Work, Duo, and project navigation fit their real content

- Daily Work can move between every retained local date with a native date control, reload-safe selection, and truthful unavailable states. Dates from before Daily Work existed remain unavailable rather than being reconstructed from incomplete history.
- Duo setup gains a distinct overlapping-chat mark, stronger contrast, calmer cards, and a compact optional judge section that remains positioned inside the dialog at narrow and wide sizes.
- Project action menus now dismiss on outside interaction like Work menus, while rename focus remains stable through the menu-to-editor transition. Composer, minimap, and dialog layouts continue to adapt across split panes and detached windows.

### Release summaries reach Discord without exposing the webhook

- Settings gains a Discord release-summary surface for a public GitHub or GitLab repository. Inertia compares the latest release with its predecessor and groups a bounded deterministic local diff into improvements, implementations, bugs, and other changes before posting one Discord embed.
- The incoming webhook is stored only in the operating system credential vault. SQLite and the renderer receive configured state rather than the secret, and the privileged main process re-fetches authoritative release metadata immediately before posting instead of trusting renderer-supplied tags, titles, or dates.
- Empty settings remain inert at startup, repository and payload sizes are bounded, public hosting responses are validated, and JSON-safe Discord construction preserves a clean no-secret failure path.

### Release confidence

- Hosted Windows Git and PDF fixtures retain their product deadlines and assertions while receiving enough test-harness startup headroom for copied executables and native canvas loading. Exact-head Linux, macOS, Windows desktop, and both Windows unit shards are green before the release branch starts.
- Architecture and both lint layers, all TypeScript projects, 4,176 unit and integration tests, 430 portable provider contracts, real Electron scenarios, Private Connect, production builds, renderer budgets, native package smoke, Electron fuses, refreshed README screenshots, and the dedicated release PR protect the release.

## 0.0.40 — 2026-08-20

### Chats can move, share context, and coordinate without sharing authority

- Up to eight conversations can move into independent native windows with remembered bounds, taskbar presence, optional always-on-top, and an explicit return to the main workspace. Each chat keeps one interactive composer owner, drafts transfer only when they can be handed off losslessly, and closing a window leaves active agent work running.
- A new cross-chat context chooser shares only the exact visible messages the user selects. Immutable bounded provenance survives reload, different workspaces require acknowledgement, and provider host actions can request context without browsing transcripts or choosing message IDs.
- After one exact approval, Codex, Claude, Cursor, and OpenCode can use host-owned tools to list, inspect, create, dispatch, follow up, observe, stop, and archive independent top-level Inertia chats. Recursion, concurrency, payloads, access, project scope, and lifetime are bounded; credentials, provider sessions, paths, and transcripts remain outside the tool bridge.

### Providers and rich files keep their exact lifecycle

- Native Kimi Code joins the provider catalog with durable migration, managed model and thinking routes, MCP, resume, cancellation, process recovery, typed failures, and the genuine bundled Kimi mark, while existing Kimi-through-Claude profiles remain intact.
- Codex App Server, Claude Agent SDK, Cursor ACP, and OpenCode SDK now share stricter run ownership, cumulative event and byte ceilings, transcript correction, cancellation, cleanup, and redaction behavior. Late or cross-run events remain inert instead of being projected into the wrong conversation.
- Images, PDFs, text, Markdown, JSON, CSV, XLSX, and XLS attachments keep private sent-message previews after reload. PDF and spreadsheet work stays lazy and bounded, scanned PDF pages become provider images only within the shared limits, and unsupported or unsafe documents fail closed.
- Linux runtime recovery journals the exact PID, original parent, process group, process start time, boot, and generation for every owned child. A crashed utility runtime can retire only proven matching descendants before normal work resumes; ambiguous identity remains quarantined.

### Everyday controls are clearer and more truthful

- New and active chats share the same responsive two-tier composer. Literal `$skill-name` tokens are the source of truth, checkout and branch information stays quiet, and Send, Stop, follow-up, and Copy feedback animates only after the corresponding authoritative acceptance or clipboard success.
- Claude OAuth links open through the trusted desktop host without forwarding display state or provider-controlled browser commands. Markdown chat links retain heading targets through Files, and preview failures offer bounded Retry and Source recovery.
- Daily Work uses a simpler day-card mark, announces its dialog state, and keeps reduced-motion-safe activity waves. Release publication can notify Discord with JSON-safe payload construction and a clean no-secret fallback.

### Release confidence

- Version 0.0.40 is prepared and reviewed on a dedicated release PR. Release-candidate PRs run the same complete Windows `npm run check` gate used by an exact tag, in addition to the existing Windows shards and Linux/macOS platform matrix, so the tag is no longer the first full Windows proof.
- The contended Windows generated-PDF cleanup fixture now warms its native canvas dependency before starting the product deadline, preserving the exact second-page cancellation assertion without confusing dependency cold start with product behavior.
- When a fast Linux child exits between spawn and exact ownership claim, Inertia now retires the fail-closed pending record only after proving both its PID and process group are gone. Short provider probes can no longer leave a clean runtime generation permanently blocked from recovery.
- Architecture and both lint layers, all TypeScript projects, more than 4,200 unit and integration tests, 430 portable provider contracts, real Electron scenarios, production builds, audits, renderer budgets, package smoke, Electron fuses, screenshots, and exact-head release gates protect the release.

## 0.0.39 — 2026-08-19

### Provider work stays attributable from start to finish

- Codex child threads are registered from every authoritative SDK start path, buffered child-first events replay in bounded order, terminal events deduplicate, and cancellation interrupts children before their root. JSONL writes, RPC ownership, topology, payload bytes, and provider process cleanup are now enforced at the same boundary.
- Claude correlates every accepted follow-up and delegated task with its exact provider identity while keeping child-owned streams out of parent output. OpenCode replays valid out-of-order parts against the current prompt, and Cursor covers the installed ACP lifecycle and permission shapes without mistaking the editor launcher for the agent executable.
- Delegated-agent cards show readable names, roles, and missions. Their rosters remain folded by default, remember an explicit open choice for the exact conversation and turn, and stay bounded and fail-safe when local preference storage is unavailable.

### Failures and active work explain themselves without adding noise

- Failed provider runs retain a scrubbed one-line summary and an expandable, copyable diagnostic dossier with bounded execution facts, cleanup state, technical causes, and recent provider context. Prompts, answers, credentials, project roots, raw session identifiers, and token values remain excluded.
- The composer separates writing from a keyboard-ordered control rail for context, route settings, usage, and message actions, while narrow layouts keep every action reachable and popovers inside the workspace.
- Live status motion continues when Inertia is visible behind another window, pauses when the document is hidden, and resynchronizes elapsed time and sidebar geometry on return. Daily Work uses a compact native day-ledger mark, and redundant renderer subscriptions and styles were consolidated to restore enforced bundle headroom.

### Release confidence

- Exact-tag publishing now tolerates GitHub's delayed draft-release visibility with bounded retries before asset verification and upload, avoiding a manual rerun without weakening no-replacement safeguards.
- Delegated-agent cancellation fixtures now wait for an explicit protocol acknowledgement before stopping child turns, preserving the real children-before-root contract without racing the Windows full-suite decoder.
- Architecture and both lint layers, all TypeScript projects, more than 3,700 unit and integration tests, portable provider contracts, Electron scenarios, production builds, bundle budgets, package smoke, Electron fuses, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.37 — 2026-08-19

### Files and live conversations handle rich content safely

- Markdown and Markdown-linked project images now render directly in Files with accessible Preview and Source modes, exact heading and cross-file navigation, bounded near-viewport loading, strict image validation, and a safe source fallback for incomplete or oversized documents.
- Image-only and text-plus-image follow-ups can reach an active Codex, Claude, or OpenCode turn without changing its identity or ordering. Private copies, provider acknowledgement, persistence, rollback, and Claude queue reservations remain bounded and attributable across success, failure, cancellation, and restart.
- Claude Read results accept legitimate resized or optimized images while retaining strict MIME, base64, duplicate-payload, event, aggregate-size, and unchanged-PDF validation.
- Cancelling an in-progress database backup no longer lets native validation hold application shutdown open. No partial is published, and a Windows file handle that is still settling remains explicitly unpublished for safe startup cleanup.

### Appearance and active work read more clearly

- A keyboard-accessible theme library adds Inertia, Grove, Ocean, Ember, and Iris palettes across light and dark appearance, terminal colors, first paint, persistence, recovery, and restart. Schema 59 stores the selected palette.
- `/resume`, `/compact`, and the slash-command menu share a stable floating command surface with complete keyboard navigation and clear provider and completion states. Daily Work gains denser totals, truthful provider shares, stable conversation rows, a fixed explanatory footer, and reduced-motion-safe loading.
- Live commentary, tool actions, delegated agents, and Goal tasks now use bounded Beautiful UI motion tied to real states, including truthful warning and failure colors. Concurrent working chats keep their canonical run order instead of jumping as activity updates arrive.

### Release confidence

- Windows unit tests are split into two isolated single-worker shards without reducing coverage, while cross-platform compaction, layout, and release-draft checks are more deterministic. Architecture and lint layers, all TypeScript projects, more than 3,700 unit and integration tests, portable provider contracts, Electron scenarios, production builds, bundle budgets, package smoke, Electron fuses, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.36 — 2026-08-18

### Updates install only when the package can prove they are safe

- Update-capable packages can now check, download, cancel, retry, report progress, and restart into a verified release. Real release AppImages opt in after replaceability checks; Windows and macOS opt in only with complete Authenticode or Developer ID signing and notarization. Development, unsigned Windows, and ad-hoc macOS builds retain the manual browser flow.
- Installation waits for provider runtimes, terminals, database recovery, and durable Private Connect work to release privileged ownership before Electron hands off to the native updater. Ambiguous shutdown, filesystem, signing, or handoff state fails closed instead of risking live work.
- Exact-tag publishing now validates update metadata, package digests, blockmaps, and the complete cross-platform asset union before publication. Draft reuse cannot overwrite or silently replace an asset, `SHA256SUMS.txt` covers the public set, and build provenance attests that same verified union.

### Daily work and conversation navigation stay clear

- A lazy Daily Work dashboard summarizes the selected local day with settled runtime and token totals, provider breakdowns, and navigable conversation cards. Work crossing midnight is clipped to the requested day, older conversations with work today remain visible, and active turns appear without being counted as settled.
- New-chat defaults now show the persisted provider, model, and reasoning choices truthfully across restarts, including explicit provider and model defaults when no override is stored.
- The in-chat prompt index uses a compact Codex-style line rail with progressive neighbor expansion while preserving stable targets, keyboard navigation, virtualization, tooltips, screen-reader labels, reduced motion, and forced-colors behavior.

### Agent activity uses the Beautiful UI motion contract

- Loading, reasoning, streamed answers and citations, approval paging, tool disclosures, task rows, prompt suggestions, context cards, diff filtering, connected plan rows, changed files, and usage insights now carry the matching Beautiful UI durations, easing, blur, transforms, shimmer, stagger, loader sequences, and chart interpolation on real Inertia state.
- The approval surface is a keyboard-native multi-question pager that preserves answers, while counted diff filters and insight charts remain tied to authoritative application data. All 20 referenced primitives are mapped to existing workflows; showcase-only behavior that would require invented runtime data remains deliberately omitted.
- Motion honors the operating system's reduced-motion preference and stays code-split with the response timeline so the renderer entry bundle remains inside its enforced budget.

### Release confidence

- Architecture and both lint layers, all TypeScript projects, more than 3,600 unit and integration tests, portable provider contracts, focused renderer and Electron scenarios, production audits, bundle budgets, package smoke, Electron fuses, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.35 — 2026-08-14

### Standard Codex requests remain standard

- Current Codex App Server versions report the normal processing tier as `default`. Inertia now accepts that canonical Standard attestation, as well as the legacy empty value, for new and resumed conversations and native compaction.
- Fast remains fail closed: a Fast request still requires the exact priority-tier attestation. Claude retains its separate exact on/off verification, while Cursor and OpenCode continue to expose no native response-speed control.

### Release confidence

- Focused Codex and cross-provider contracts, the 335-test portable protocol suite, architecture and lint layers, all TypeScript projects, more than 3,500 unit and integration tests, renderer bundle budgets, Electron scenarios, native package smoke, fuses, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.34 — 2026-08-14

### Live work stays truthful and easy to navigate

- Agent status now follows the newest real provider or runtime event instead of retained text or reasoning. Starting, thinking, searching, coding, commands, tools, responses, approvals, and input waits settle immediately through the transcript, composer, goals, delegated controls, and workspace when a turn completes, fails, or is interrupted.
- The Work index uses compact, accessible conversation rows with restrained motion and bounded virtualization. Large histories preserve keyboard navigation, fully managed action-menu focus and dismissal, rename state, provider identity, split-workspace cues, and collapsed Earlier, Done, and Snoozed preferences without mounting every row.
- Project-file references recognize Java and common source languages, share bounded syntax highlighting across chat, Files, changes, and diffs, and open validated line or range citations at the exact source while preserving literal filenames and project containment. Newline-dense previews render a bounded window around the requested line instead of creating an unbounded renderer DOM.

### Provider controls are native and explicit

- `/compact` now compacts the selected native provider session for Codex, Claude, Cursor, or OpenCode, reports whether an optional focus instruction was forwarded, refreshes usage, and refuses unsupported, stale, interactive, or ambiguously completed operations. OpenCode accepts a genuine lifecycle emitted in the request millisecond while retaining exact session, reason, and message pairing.
- Standard and Fast controls appear only when the selected native provider advertises an authoritative capability. Codex uses its priority service tier and Claude uses SDK Fast mode; the exact choice survives continuation, restart, split chats, prompt stashes, and bound presets without inventing support for other routes.
- Read-only Git refreshes now cancel and settle their sibling status or diff process before returning an error, preserving the triggering failure while preventing Windows repository handles from escaping cleanup.

### Release confidence

- Architecture and both lint layers, all TypeScript projects, more than 3,500 unit and integration tests, 334 portable provider contracts, focused Electron scenarios, renderer bundle budgets, package smoke, Electron fuses, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.33 — 2026-08-13

### Images reach providers in packaged builds

- Pasted and selected images now survive durable retention in production packages even though Electron's `RunAsNode` fuse is disabled. Store operations run through a bounded main-owned utility process instead of attempting to launch the packaged desktop executable as a Node helper.
- Persist, read, and remove operations remain tied to the exact private attachment root and runtime generation. Malformed results, cancellation, crashes, overlapping work, and unconfirmed helper shutdown fail closed; process and payload concurrency stay bounded.
- Native package smoke rereads the exact retained image bytes with production fuses enabled, and the Electron Codex scenario verifies that the provider receives the same SHA-256 bytes the user pasted.

### Release confidence

- Architecture and both lint layers, all TypeScript projects, more than 3,300 unit and integration tests, 288 portable provider contracts, exact-byte Electron delivery, package smoke, Electron fuses, and exact-head Linux, macOS, and Windows gates protect this focused repair.

## 0.0.32 — 2026-08-13

### Attachments stay owned throughout sending

- Image, PDF, and file sends now bind each staged attachment to the exact renderer request before submission. A late utility-runtime claim can no longer lose a race with renderer cleanup and make an otherwise valid send fail.
- Ambiguous transport outcomes remain retryable without weakening ownership. A retry retires the complete intersecting handoff only when neither the current nor a quarantined runtime owns any attachment; omitted files resume their pending cleanup, stale request tokens fail closed, and unlink failures cannot be mistaken for successful release.
- Abandoned handoffs remain bounded, renderer and runtime identities are validated across preload and IPC, and cleanup rechecks ownership after deletion so crossing claims cannot leak or remove a live attachment.

### Release confidence

- The repaired lifecycle is covered across registry, release coordination, preload/runtime protocol, renderer retry behavior, runtime quarantine, attachment resolution, Electron send/preview scenarios, and exact-head Linux, macOS, and Windows gates.

## 0.0.31 — 2026-08-12

### Work, Environment, and Usage stay compact and truthful

- Work is now a clean, search-first task list grouped into Recent, Yesterday, Earlier, Done, and Snoozed. Compact rows keep the genuine bundled Codex, Claude, Cursor, or OpenCode mark beside repository, branch, status, and time without the old filter strip or a second Runs surface.
- The duplicate Activity/Runs popup is gone. Live services, failed checks, acknowledgements, previews, and Stop remain available in the owning workspace's Environment panel, with conversation context preserved when more than one chat can act on similar work.
- Environment opens by default for fresh workspaces and follows the compact Codex-style hierarchy: Changes, worktree, branch, Commit and Push, validated local servers, provider usage, repository, editor, attachments, and delegated work. It avoids a decorative Ready badge while keeping real recovery, offline, and attention states visible.
- A dedicated Usage destination adds 7-, 30-, and 90-day provider, model, and day views for locally measured terminal-turn tokens. Coverage and missing data stay explicit, provider marks remain distinct, and cost is unavailable rather than estimated or fabricated.

### Goals and sent context survive real interruptions

- Codex-native goals continue automatically across provider turns, create a native thread when Set Goal is the first action, and remain resumable after Stop or a hard runtime restart. Continuation timeouts fail visibly instead of leaving an Active goal without a runner, goal mutations serialize with startup, and budget-limited work requires a deliberately raised or removed token target before resuming.
- Images, PDFs, and other sent attachments remain visible with their messages after sending and restart. Private copies use durable reference-counted retention, bounded startup reconciliation, exact capability validation, fail-closed symlink containment, and cleanup that waits for owned child processes before releasing its mutation barrier.
- Claude media delivery now budgets UTF-8 bytes as well as event count, preserving bounded image and PDF inputs without splitting or silently corrupting multibyte provider output.

### Provider and Duo recovery remains fail closed

- Provider ownership is recorded durably before execution and retired only after authoritative cleanup. Raw crashes, unexpected Codex app-server exits, failed process-tree termination, and stale runtime generations keep mutations, attachments, and deletion fenced until recovery can prove ownership is gone.
- Duo restores incomplete launch and deletion state conservatively, preserves exact checkout reservations through retries, and refuses project or conversation deletion while a provider, terminal, attachment, generated file, or revalidated worktree remains owned.
- Runtime cleanup receipts and generation leases use bounded, owner-private, direct-root journals with exact crash replay, no-follow reads, BigInt filesystem identity, and platform-aware process termination. Synthetic downgrade fixtures and Windows lifecycle tests now exercise those same authority boundaries without weakening production migrations.
- Database schema 55 adds durable provider-run ownership, schema 56 sanitizes persisted attachment capabilities, and schemas 57–58 add and validate Usage indexing while invalidating legacy starts that cannot be attributed safely.

### Release confidence

- Architecture and both lint layers, all TypeScript projects, more than 3,300 unit and integration tests, 285 portable provider contracts, focused Electron scenarios, production audits, renderer budgets, desktop performance, package smoke, Electron fuses, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.30 — 2026-08-10

### Git actions stay visual, reviewed, and repository-scoped

- The workspace header now presents one contextual Git action plus a complete keyboard-accessible menu for Commit, Pull, Push or Publish, and Pull request. Branch state, ahead/behind counts, and exact disabled reasons stay visible instead of leaving routine source-control work hidden in terminal commands.
- Changes uses one repository picker and file navigator for both the project root and nested repositories. Review state, commit, push, pull-request recovery, and repository identity follow the selected repository without exposing a stale diff under a newly selected path; root-only revision and summary boundaries remain explicit.
- A commit is built from the exact prospective content the user reviewed, consumes a one-shot receipt, and changes only the selected paths while preserving unrelated staged work. Repository, Git metadata, branch, index, signing policy, or reviewed content changes fail closed before mutation.
- Reviewed commits use Git-native reference locks plus a durable private index journal so an acknowledgement loss, timeout, crash, packed ref, or Windows cleanup race cannot silently create a second commit or erase another Git operation's lock. Recovery completes or preserves only Inertia-owned artifacts before later branch, pull, push, or pull-request work proceeds.

### Completed answers, activity, and delegated work read at a glance

- **Jump to completed answers** positions each newly persisted final answer at the beginning of the transcript viewport by default. It settles delayed and virtualized layout without moving historical conversations or hydrated answers, stops immediately for deliberate reader navigation, and can be disabled in Settings.
- Runs are grouped chronologically into **Recent**, **Yesterday**, and **Earlier**. Each row keeps its provider icon and configured alias beside project, branch, status, and occurrence time, while historical provider attribution comes from the immutable run projection rather than whichever route the chat uses now.
- Delegated work shows provider and harness identity, live elapsed time, provider-reported hierarchy, compact progress, and terminal outcomes in a bounded tree. Separate live or failed branches remain represented, settled history collapses behind an accessible disclosure, **Guide parent** remains an ordinary follow-up, and direct Stop appears only for an exact live Claude Agent SDK task.

### Duo, documents, providers, and worktrees recover conservatively

- Duo keeps launch and deletion locks until cancelled providers actually detach, reconciles ambiguous judge retry or cancellation acknowledgements, and resumes only durable eligible comparisons after restart. Isolated launches pin their source repository identity; owned worktrees carry durable creation and filesystem receipts, ambiguous or still-registered artifacts require manual Git cleanup, and projects cannot be removed around unresolved owned chat worktrees.
- Project and conversation paths are enrolled with persistent filesystem and Git identity receipts. Provider runs, terminals, project actions, and Git commands revalidate those authorities so a same-path replacement or symlink swap fails closed instead of inheriting workspace access.
- Text PDFs retain bounded selectable text, while scanned or sparse pages become private UUID-named JPEG inputs for image-capable routes. Page count, dimensions, memory, files, and aggregate bytes are bounded; mixed PDFs share image capacity fairly; generated pages are removed after completion, cancellation, failure, and restart without exposing their private paths in prompts or persistence.
- Claude skill discovery and selection now use bounded, revalidated private staging and one owned SDK process tree. Claude, Cursor, and OpenCode reject unsafe approval display text, bound provider event state and cleanup, and publish terminal results only after owned processes settle. Attachment preflight rejects over-limit selections before reading renderer bytes, while late, unsent, or cancelled private attachment leases are released instead of drifting into another chat or reload.

### Reusable prompt presets stay deliberately narrow

- The composer can create, search, insert, edit, duplicate, reorder, and delete up to 30 reusable prompt presets. Applying one edits only the selected composer: it does not send automatically, consume the scratch stash, move attachments, or cross into the other side of a split workspace.
- A preset stores bounded text and, only when explicitly enabled, the exact harness, backend, model, and reasoning identity. A route-bound preset explains and refuses a mismatched chat until it is deliberately rebound; endpoints, provider options, capabilities, filesystem context, continuation identity, attachments, chat context, and credentials are outside the preset contract.
- Presets live in the local database with revision-checked mutations and are included in both shell and full reconnect snapshots. Schema recovery validates the table, ordering index, and count-limit trigger before accepting a current database or backup.

### Release confidence

- Provider SDK and supporting dependency updates remain isolated behind their deterministic contracts. Architecture, lint, type, migration and recovery, portable-provider, Electron, performance, production-audit, bundle-budget, packaging, fuse, signature, checksum, provenance, and exact-head Linux, macOS, and Windows gates protect the release.

## 0.0.29 — 2026-08-09

### Runtime boundaries reject ambiguous state

- Every runtime-to-renderer result is validated deeply before it can affect the desktop. Conversation, turn, run, message, activity, reasoning, plan, goal, review, provider, Git, Duo, project-action, and workspace identities now preserve their real storage and ownership relationships instead of relying on shallow array checks.
- Runtime WebSocket delivery uses a 1 MiB soft watermark with progress acknowledgement, a five-second no-progress watchdog, and a 64 MiB absolute queued-byte ceiling. Legitimate multi-megabyte hydration can drain and continue receiving events, while a genuinely stalled consumer remains bounded and disconnects.
- Recovery validates every released v47–v49 column and index before accepting a primary database or backup. Git and provider subprocesses keep only the required non-secret discovery, configuration, network, and identity environment while preserving shell-free, bounded process-tree ownership across macOS, Linux, and Windows.

### Threads stay visible, attributable, and manageable

- Pinning, snoozing, status filters, and a quieter chat index make long project histories easier to scan. Snooze works in the default classic sidebar, keeps active or input-blocked work visible, and expires on time without waiting for an unrelated snapshot.
- Privacy-preserving desktop notifications cover completion, failure, approval, and input transitions. Clicking one recreates or waits for the desktop window, survives renderer hydration, targets either split pane correctly, closes obstructing non-destructive overlays, and keeps working after notification generation is disabled.
- Provider aliases and custom keybindings are consistent across Settings, model selection, the composer, live turn attribution, maintenance notices, Duo, and command search. Rapid edits merge optimistically without stale snapshots or rejected writes erasing newer local input.

### Desktop workflows do more without widening authority

- Inertia can create a GitHub pull request through a bounded, credential-restricted `gh` process, including packaged-app executable discovery and safe Windows batch invocation. GitLab, Bitbucket, and browser fallback stay explicit, and a PR created successfully remains recoverable by URL even if the operating system cannot open the browser.
- The composer exposes the active goal and supported actions directly, shows why skills or tools are unavailable, carries explicit preview context, and stores bounded recurring scratch prompts that never execute automatically.
- Settings adds aggregate process and storage health, safe Chromium-cache clearing, provider identity labels, and keybinding controls. macOS preserves the native traffic-light safe area, while the simplified sidebar and trusted-overlay handling keep navigation clear.

### Private Connect and headless foundations are more resilient

- The packaged Private Connect client is installable as a versioned PWA with a scoped service worker, read-only offline state, UUID-only notification navigation, and HTTP projection fallback while WebSocket reconnects. Authority loss and revocation still fail closed.
- A credential-free, non-listening runtime status CLI reports provider installation/protocol readiness, workspace access, and detected Git, Jujutsu, Mercurial, Subversion, or Fossil roots without exposing executable paths, environment values, authentication, or unsupported mutation claims.

### Release confidence

- Architecture and both lint layers, five TypeScript projects, 2,652 unit and integration tests, 223 portable provider contracts, 46 Electron scenarios, production audits, renderer bundle budgets, and exact-head Linux, macOS, and Windows coverage, performance, packaging, fuse, signature, and smoke gates protect the release.

## 0.0.28 — 2026-08-09

### Goals and native sessions start from the composer

- `/goal` opens the real per-chat goal workflow directly from the composer, while `/resume` lists every eligible native Codex, Claude, Cursor, or OpenCode session that belongs to the current directory. Draft chats resolve through their visible project or worktree instead of requiring an already persisted conversation.
- Native-session terminals preserve exact conversation ownership and retry creation only after a definite not-sent result. Ambiguous delivery never creates a duplicate process, and terminal connection recovery remains bounded rather than silently falling back to a fresh provider session.
- Pending provider questions stay visible beside the active work instead of disappearing into an unreadable activity ledger, and the animated provider-working label now loops without a visible seam.

### Duo finishes the comparison without taking over stale work

- The optional third-model judge is presented in a compact disclosure instead of extending the setup beyond the viewport. Inertia monitors the launched pair in the background, waits for both authoritative terminal states, and opens the completed judge as the primary chat only when the user is still looking at that exact Duo.
- Settings, split changes, project or conversation navigation, chat creation, and source follow-ups cancel or supersede the automatic handoff deterministically. A queued judge can no longer replace newer user work, and an activating send cannot race the pending selection.
- Provider questions raised during either source turn remain actionable, while failed, cancelled, or interrupted comparisons retain explicit recovery controls instead of pretending the judge completed.

### Expensive diffs use bounded parallel work

- Ordinary patches still parse synchronously. Unified diffs above 256 KiB move into a lazy, bounded worker pool so pathological reviews can use more than one renderer core without multiplying workers for normal work.
- Parse-dependent review and reversal actions fail closed while aggregate parsing is pending or failed. Superseded work is aborted, worker failures are bounded, refreshed snapshots retry safely, and the original patch remains available rather than being mistaken for an empty diff.
- The project sidebar returns to a simpler, quieter hierarchy without the heavy folder overlay or duplicated hover label.

### Release confidence

- Architecture and lint checks, four TypeScript projects, 2,360 unit and integration tests, 222 portable provider contracts, 46 Electron scenarios, production audit, 15 resolved exact-review threads, a clean final exact-head review, and green Linux, macOS, and Windows coverage, performance, packaging, fuse, signature, and smoke gates protect the release.

## 0.0.27 — 2026-08-08

### Chats keep their exact workspace and visible state

- Branch, Git, review, project-action, terminal, and file work now resolves through the owning chat and its exact worktree. Draft selection and replacement failures preserve eligible text instead of activating a partial destination, while native-preview shortcuts forward only the exact allowed commands.
- Reconnect hydration keeps the mounted conversation detail, live deltas, drafts, attachments, queued skills, file and Git state, pane ownership, plans, and transcript position until authoritative replacements arrive. An ambiguous mutation timeout no longer recycles an otherwise healthy socket, and Git invalidations remain durable across reconnects.
- Ordinary sends, Private Connect prompts, review questions and revisions, Duo judges, native provider terminals, project actions, source-control operations, sibling chats, and provider cleanup now share canonical checkout authority. Reverse-order races fail closed before a second provider or destructive workspace operation can join the same worktree.

### Duo, goals, and native continuation become first-class

- Duo can optionally lock both source chats and dispatch a separately configured third-model judge after both first turns settle. The judge receives only a bounded brief, attributed visible assistant output, and terminal status—never source sessions, hidden reasoning, tools, attachments, credentials, or permissions—and interrupted judgments require an explicit retry or cancellation.
- Each chat exposes its real Codex-native goal or Inertia-local objective directly from the conversation header, with source, hierarchy, status, and supported actions preserved instead of hiding goal work inside a secondary panel.
- Eligible native Codex, Claude, Cursor, and OpenCode sessions can continue in the owning integrated terminal through server-verified session identity and direct shell-free argv. Inertia refuses stale, custom, missing, active, or unverified identities rather than using a picker, `--last`, a fresh-session fallback, or emulation; Windows batch shims, terminal replacement, process-tree shutdown, split-pane ownership, and the four-terminal cap remain bounded.

### Frequent surfaces open sooner and read more clearly

- Activity, command palette, Settings, and other frequent deferred surfaces preload on bounded idle or intent paths. The Settings chunk remains under its 50 KiB budget, while measured first opens fall from roughly 290–303 ms to low single-digit milliseconds in the representative fixture.
- Settings use calmer neutral surfaces with stronger hierarchy, terminal status and conversation-minimap targets remain readable, and reduced-motion and keyboard behavior keep the same accessibility contract.

### Release confidence

- Architecture and lint checks, four TypeScript projects, 2,330 unit and integration tests, 222 portable provider contracts, 46 Electron scenarios, Windows Codex portability, production audit, exact-head review, and green Linux, macOS, and Windows performance, packaging, fuse, signature, and smoke gates protect the release.

## 0.0.26 — 2026-08-08

### Model routes stay authoritative from chooser to execution

- Lightweight conversation updates now replace the complete authoritative route shell without discarding already loaded detail. Provider, backend, model, reasoning, and continuation identity therefore stay synchronized after refreshes, reconnects, split-pane work, and Duo launches.
- Native provider-default routes remain explicit even when catalogs are empty. Cross-provider and incompatible route changes create the required replacement chat, preserve eligible text drafts, and cannot smuggle stale continuation identity into a new provider session.
- Backend-profile saves compare canonical execution semantics, so a rename or no-op save does not invalidate active routes. Disabled profiles lead to **Open setup**, while genuinely stale saved routes stop advertising Probe or Refresh actions that cannot repair immutable history.
- Markdown code Copy/Wrap state and table export controls keep stable component identity across parent rerenders instead of remounting and losing local interaction state.

### Provider and desktop lifecycles fail closed

- Claude Stop discards accepted follow-ups and closes the per-turn SDK query whenever UUID-less queued input could survive interruption, preventing cancelled full-access work from running later.
- Cursor and OpenCode now launch Windows npm batch shims through the hardened `shell:false` adapter. Cursor also treats every ACP configuration response as authoritative before choosing reasoning and republishes the final option set.
- OpenCode exposes and accepts models only from providers the SDK reports as connected, keeps variant order separate from provider-default reasoning, and no longer treats a successful `0 credentials` listing as runnable.
- A runtime that reports startup failure but stalls during cleanup is force-terminated after a bounded grace period. Runtime and Private Connect shutdown begin concurrently, and Tailscale commands wait for stdio closure so trailing diagnostics are not lost.
- Global shortcuts cannot mutate the workspace behind an open modal. The command palette now traps Tab navigation, takes focus synchronously, and restores the opening control when closed.

### Release confidence

- The provider pass was contrasted read-only with T3Code commit `2c7267ad43a05cf3e30343400c76fd9ac47698e7`, while pinned Claude, OpenCode, and ACP contracts remained authoritative.
- Architecture and lint checks, four TypeScript projects, 2,237 unit and integration tests, 222 portable provider contracts, focused Electron journeys, production audit, independent exact-head review, and green Linux, macOS, and Windows E2E, performance, packaging, fuse, signature, and smoke gates protect the release.

## 0.0.25 — 2026-08-05

### Private Connect replaces the hosted companion stack

- The retired relay-based Remote Companion is replaced by a packaged, Tailscale-only Private Connect PWA. Inertia binds an ephemeral loopback gateway and exposes only that gateway through an ownership-checked private HTTPS Serve mapping—never Funnel, public HTTP, a hosted relay, or an inbound LAN listener.
- Five-minute fragment-only invitations, matching comparison codes, explicit desktop approval, encrypted device grants, secure host cookies, CSRF checks, and single-use WebSocket tickets protect pairing and reconnects. Locking the desktop closes live access immediately while preserving a non-expired grant for a safe reconnect after unlock.
- Monitor devices receive bounded sanitized conversation projections. Collaborate devices may additionally submit idempotent supervised prompts, answer non-secret input, and stop the exact active run; files, terminals, Git, approvals, secrets, provider settings, Full Access, and arbitrary command execution remain desktop-only.
- Connections & devices now surfaces pending approvals outside Settings, reports genuinely live browser sessions, and lets the user edit a paired device's access level, project scope, expiry, or revoke it. The packaged PWA includes responsive light and dark presentation, bounded concurrent requests, stable reconnect behavior, and safe same-delivery prompt retries after an uncertain acknowledgement.
- Legacy Remote Companion configuration and artifacts are removed deliberately. Existing companion pairings are not migrated and must be approved again through Private Connect.

### Provider routes and remote questions stay usable

- The model chooser keeps a native **Provider default** route available when Codex, Claude, Cursor, or OpenCode returns an empty model catalog, even when custom backend profiles also exist. Cross-provider choices persist the complete provider and model identity, while signed-out routes lead to **Connect** instead of failing after submission.
- Private Connect preserves provider-supplied question identities, including non-UUID identifiers, and supports bounded free-form answers alongside structured choices without exposing secret-input prompts to the browser.
- Pairing collection windows, WebSocket liveness, constant-time CSRF validation, scoped connection policies, Windows-safe Tailscale discovery, and cleanup diagnostics close the remaining cross-platform lifecycle edges.
- Architecture and lint checks, four TypeScript projects, 2,199 unit and integration tests, 218 portable provider contracts, Electron scenarios, production audit, packaged Private Connect asset verification, fuse checks, and native package smoke are green on Linux, macOS, and Windows.

## 0.0.24 — 2026-08-04

### Recovery waits for a genuinely quiet moment

- Initial, first-settled-turn, hourly, and validation-retry backups now share one scheduler that deduplicates pending work and waits until turns, critical settlement, recovery operations, and other backups are quiet.
- Every completed, failed, or cancelled turn renews the complete interaction grace period. Validation failures use a separate bounded exponential backoff, so an ordinary eligibility retry cannot accidentally shorten either deadline.
- Explicit manual backups still start immediately after joining any in-flight operation, successful manual work satisfies racing automatic requests, and shutdown cancels pending timers and unfinished backup work without starting new database-sized work.
- Recovery coverage now exercises blocked triggers, trigger races, rotation, finite retry exhaustion, shutdown cancellation, consecutive settlement, and the precedence between interaction grace and validation backoff.

### Long transcripts stay measurable without stealing focus

- Follow-latest converges through bounded virtual-row and Git-artifact layout corrections, reaches the real settled bottom, and yields immediately when wheel, touch, pointer, or keyboard input shows that the reader moved into history.
- A late content or resize callback can no longer reclaim the viewport after intentional navigation on slower Windows runners. **Jump to latest**, a newly accepted turn, and a conversation change remain explicit ways to resume following.
- The desktop benchmark now uses an authoritative 300-turn conversation plus a separate recovered-history stress case, measures the complete provider-to-paint path over repeated samples, and retains raw stage attribution without counting hidden paints produced by the old auto-follow race.
- Hosted performance gates preserve reader navigation, final-answer visibility, real bottom reachability, mounted-row bounds, streaming latency and cadence, long-task and frame evidence, WAL growth, workspace release, repeated cycles, and long-session soak behavior across all three operating systems.

### Provider startup and runtime recovery are less surprising

- `CODEX_HOME=~/…` is expanded before shell-free Codex discovery and launch on macOS, Linux, and Windows, while other-user and variable syntax remains literal instead of being interpreted by a shell.
- A runtime-ready signal that arrives during a failed renderer connection attempt now invalidates that attempt and reconnects immediately rather than waiting for exponential backoff.
- Turn Git-artifact finalization and the desktop benchmark share the same explicit timeout contract, keeping product behavior and release evidence aligned.
- Architecture and lint checks, four TypeScript projects, 2,424 unit and integration tests, 53 Electron scenarios, repeated transcript anchoring, portable provider contracts, production audit, desktop benchmarks, native packaging, fuse verification, and package smoke are green on Linux, macOS, and Windows.

## 0.0.23 — 2026-08-03

### Supervision and recovery stay truthful

- Legacy Codex patch approvals once again use the provider's supervised flow, reject unsafe display text, and show every bounded source and move destination before the user decides.
- Duo dispatch and recovery are durable across partial launches, restarts, deletion attempts, and explicit acknowledgement. Obsolete recovery alerts clear only after an authoritative clean recheck.
- Remote Companion now distinguishes an absent browser identity from an expired sealed or legacy grant during cold start. Expired grants are removed, never open transport, and lead directly to truthful re-pairing guidance.
- Recovery status no longer describes an unvalidated retained SQLite backup as verified, and the UI distinguishes portable export from full database recovery.

### Frequent paths respond sooner

- Sustained transcript streaming now uses a measured 64 ms cadence while preserving the fast first flush, Unicode boundaries, persistence ordering, terminal delivery, and restart reconstruction.
- Frequent lazy surfaces prefetch on idle or intent, show immediate loading shells, avoid high-frequency backdrop blur, and use shorter interaction motion without weakening reduced-motion behavior.
- Expensive recovered history stays collapsed and unmounted until requested. Its cost includes inferred turns, messages, reasoning, plans, checkpoints, and activity detail, and a same-conversation history that becomes expensive collapses before mounting the new weight.
- Model-route refresh and asynchronous menu updates preserve navigation and restore focus only when the user has not deliberately moved it elsewhere.
- Production-path platform and desktop benchmarks cover streaming paint and gaps, long tasks, SQLite WAL growth, long-thread scrolling, first-open latency, split panes, terminal activity, scaling, memory, and repeated-open soak behavior without relaxing the established hosted ceilings.

### Provider, remote-release, and supply-chain confidence

- Remote Companion browser and relay artifacts carry checked component versions and release-time compatibility validation while the conditional-projection floor remains pinned to protocol version 0.3.0.
- OpenCode SDK 1.18.10 ships as an independently revertible protocol update, protected by all 217 portable provider contracts.
- Newly disclosed transitive issues are resolved with `fast-uri` 3.1.5, `ip-address` 10.4.0, and `hono` 4.12.34; the production dependency audit is clean.
- Architecture and lint checks, four TypeScript projects, 2,398 local unit and integration tests, focused real Electron expiry coverage, exact-head review, and green Linux, macOS, and Windows E2E, benchmark, packaging, fuse, audit, and smoke gates protect the release.

## 0.0.22 — 2026-08-02

### Long sessions stay lighter across every platform

- Historical transcript rows now remain stable through unrelated workspace updates, conversation drafts persist on a bounded cadence, and Activity Center clocks update without rebuilding the surrounding run list.
- Large model catalogs virtualize while preserving search, favorites, focus, and keyboard navigation. A 750-route regression keeps only a small visible window mounted instead of paying for the complete catalog.
- Workspace file metadata shares bounded containment work, and terminal output coalesces for at most 8 ms into bounded frames. The measured 10,000-callback fixture falls from 10,000 WebSocket frames to one without losing ordering or final output.
- Reproducible core, desktop, and packaged-app performance reports now run across Windows, Linux, and macOS so platform-specific regressions have evidence instead of guesses.

### Local data has a real recovery path

- SQLite startup distinguishes a clean first launch, a valid database, an unsupported future schema, and corruption. Validated rotating backups can restore the newest safe state while preserving the corrupt primary for investigation.
- Settings exposes explicit native-dialog export and import recovery flows. Imports are serialized, idempotent, project roots are reauthorized, and recovered access returns to supervised mode.
- Streamed messages and reasoning append through bounded chunks instead of repeatedly rewriting the complete growing value, then compact atomically when the turn settles. The measured WAL volume falls from 69.62 MiB to 7.19 MiB in the representative stream fixture.
- PDF and document extraction uses bounded initialization, concurrency, memory, deadlines, cancellation, and sibling cleanup. The packaged smoke path validates extraction only after the runtime is ready.

### Remote Companion becomes deployable and cheaper to keep open

- A guided local-development or self-hosted setup validates HTTPS/WSS, TLS, origin policy, headers, component compatibility, endpoint ownership, and persistence before Remote Companion can be enabled.
- Pairing uses a fragment-only companion link and QR code with a visible countdown, exact grant summary, regeneration, cancellation, and recovery actions. No invitation secret is placed in a server-visible query string.
- Relay endpoint authentication v2 adds durable host-key binding, signed challenges, epochs, bounded first claims, authenticated takeover, replay resistance, and crash-safe reset/re-pair behavior while keeping application payloads end-to-end encrypted.
- Versioned, checksummed browser and relay artifacts ship with a pinned private-network deployment recipe. The desktop still opens only an outbound connection and Inertia still operates no hosted relay.
- Browser lifecycle supervision uses one generation-owned connection attempt with bounded backoff, wakeups, terminal failure classification, stale-cache labeling, and no replay of ambiguous prompt mutations.
- Repeated unchanged state and conversation reads now use strong grant-bound validators and encrypted `not-modified` responses. A bounded large-history fixture reduces the unchanged relay envelope to under 1 KiB and saves more than 90 KiB without hiding acknowledgements or authority changes.

### Release confidence

- Architecture and lint checks, four TypeScript projects, 2,359 local unit and integration tests, 213 portable provider contracts, focused Remote Electron lifecycle coverage, production audit, exact-head review, and green Linux, macOS, and Windows E2E and packaging gates protect the release.

## 0.0.21 — 2026-08-01

### Delegated work is readable and truthful

- Subagents now show their real harness and backend route, parent relationship, elapsed time, concise activity, provider state, and terminal outcome in both the transcript and Goal panel.
- Completed, failed, cancelled, and lost delegates retain the provider's authoritative result instead of collapsing into a generic failure or a contradictory local state.
- **View turn** moves to the owning transcript turn, while **Guide parent** prepares an ordinary composer draft rather than pretending Inertia can message a child agent directly.
- Direct Stop remains available only for live Claude Agent SDK tasks whose harness can own and acknowledge the operation.

### Follow-ups and cancellation survive races

- Follow-up messages are persisted only after provider acknowledgement, preserve their original submission order, and cannot rewind conversation or project freshness while waiting.
- A delayed acknowledgement no longer clears an explicit user settlement action made while the provider was responding.
- Claude cancellation notifications may win a stop-transport race without being overwritten by a local fallback; later authoritative terminal detail can still enrich the same trace without changing its established outcome.

### Release confidence

- Architecture and lint checks, four TypeScript projects, 2,006 unit and integration tests, 202 portable provider contracts, targeted Electron coverage, production audit, five exact-head review rounds, and green Linux, macOS, and Windows CI protect the release.

## 0.0.20 — 2026-08-01

### Remote Companion fails closed at every authority edge

- Disable, revoke, permission reduction, replacement pairing, screen lock, disconnect, and shutdown serialize through durable authority-reduction markers. New sessions and late mutations remain blocked until the exact reduced state is safely persisted.
- Pairing replacement revalidates the same live request after the durable marker and before changing a key or grant, so an expired or disconnected route cannot become authorized after the fact.
- Remote prompts recheck the exact device, session, route, project, conversation, supervised access mode, and runtime state immediately before posting. The self-hosting docs now state plainly that Inertia neither bundles nor operates a public relay or companion site, and that transcript sanitization is not semantic data-loss prevention.

### Runtime reads recover without replaying writes

- Retry-safe reads keep the local socket alive through bounded slow operations, while ambiguous mutations reconnect and hydrate authoritative state before the user can retry.
- Workspace Git discovery, diffing, turn comparison, secure-root checks, and renderer authority issuance share aggregate deadlines. Stale generations cannot replace newer scans, and work that finishes after a deadline cannot create late authorities or update the UI.
- Supervised/access-mode and provider-route changes are acknowledged before a prompt is sent. Cursor's auto-edit mode now preserves its real approval semantics instead of being flattened into another access label.
- Packaged shutdown destroys the renderer only after owned runtime cleanup, while Remote Companion rejects authority mutations admitted after shutdown starts and still drains reductions already in flight.

### Long workspaces stay clearer and lighter

- Conversation minimap markers grow into a readable request preview on hover or keyboard focus without duplicate tooltips or unstable scroll anchoring.
- The active model name uses a stronger animated colour wave with explicit reduced-motion and forced-colour fallbacks.
- Files, Git state, workspace mentions, provider controls, and split panes initialize lazily and keep their state attached to the exact conversation that requested it.

### Release confidence

- Architecture and lint checks, four TypeScript projects, 2,002 unit and integration tests, 202 portable provider contracts, 42 Electron scenarios, production audit, exact-head review, and green Linux, macOS, and Windows packaging, fuse, and smoke gates protect the release.

## 0.0.19 — 2026-07-31

### Remote authority is narrower and easier to revoke

- Remote Companion grants can now be limited to explicit conversations as well as projects. Selected projects and conversations are revalidated against the current workspace before access is admitted.
- Prompt-capable grants expire within seven days, stale and archived scopes are removed, and active grants refresh on a bounded cadence without turning ordinary status reads into durable writes.
- Legacy project-wide grants remain operable through an explicit migration path and can be narrowed from Settings instead of silently gaining broader authority.
- Prompt delivery rechecks the exact device, session, route, project, conversation, access mode, and runtime state immediately before posting.

### Browser identity and protocol state fail closed

- The companion browser stores a non-extractable ECDH P-256 private key, validates the corresponding public key, and rejects malformed or mismatched persisted key pairs rather than trusting a broken identity.
- Protocol version 2 keeps the desktop, browser, and relay on one explicit contract. Incompatible peers fail clearly instead of being interpreted through an older message shape.
- Corrupt remote-vault state fails closed through documented recovery paths. The reference relay's unauthenticated endpoint-registration limitation and the deferred host-key design are explicit; application payloads remain end-to-end encrypted and replay-protected.
- Remote transcript projections are sanitized, byte-bounded, and cached within a fixed memory budget so a long conversation cannot turn remote viewing into unbounded runtime retention.

### Privileged lifecycle edges stay bounded

- Privileged IPC rejects unknown payload fields, preventing accidental authority expansion through partially understood commands.
- Project identity refreshes use bounded concurrency and preserve their cap through timeouts and disposal, including large or adversarial workspace sets.
- Screen lock, suspend, runtime shutdown, relay disconnect, and remote-session teardown now revoke or settle owned work without waiting forever on an unresponsive peer.
- New threat-model and renderer-isolation documents make implemented guarantees inspectable, while the database-recovery, relay-authentication, and security-boundary coverage documents explicitly record deferred gaps.

### Release confidence

- Architecture and lint checks, four TypeScript projects, 1,944 unit and integration tests, 198 portable provider contracts, 42 Electron scenarios, production audit, adversarial remote-authority and browser-key fixtures, three-OS packaging, package smoke, Electron fuse verification, checksums, and provenance protect the release.

## 0.0.18 — 2026-07-31

### Remote Companion, intentionally narrow

- Remote Companion adds an experimental, opt-in browser view for safe live conversation projections and separately authorized text prompts to existing supervised conversations while the desktop remains online and authoritative.
- The desktop opens only an outbound WebSocket. A dependency-minimal browser and self-hostable in-memory reference relay are included, but Inertia does not operate a hosted relay or expose an inbound desktop listener.
- Pairing uses an explicit comparison, device-specific project and scope grants, expiry, revocation, screen-lock suspension, and local audit history. Application payloads are end-to-end encrypted, replay-protected, byte-bounded, rate-limited, and stored with a separate encrypted platform-vault identity.
- Remote projections are restricted to sanitized user and assistant text. Approvals, secrets, files, attachments, terminals, Git mutation, provider settings, diagnostics, new chats, Full Access, and generic commands remain unavailable remotely.
- Prompt delivery revalidates the exact live session, route, grant, project, conversation, supervised access mode, and runtime preparation immediately before its one-time commit, preserving known non-delivery versus posted-but-unconfirmed outcomes.

### Delegated work stays truthful

- Codex and Claude subagents retain provider-reported hierarchy, status, continuation, and terminal outcomes across reconnects and persistence instead of collapsing every completed child into a generic failure.
- Live and completed delegated work exposes only actions supported by the selected harness. Guidance remains an ordinary parent follow-up, while direct child cancellation appears only when the provider can own and acknowledge it.
- Goal and activity views keep child state compact but informative, including waiting, blocked, completed, failed, cancelled, and lost outcomes without inventing lifecycle certainty.

### Stronger feedback and shutdown edges

- Long-conversation minimap markers preview the corresponding user request on hover and keyboard focus, grow predictably, and avoid duplicate browser and custom tooltip labels.
- Attachment imports, terminal process trees, provider children, and the supervised utility runtime now use bounded shutdown and explicit process-tree confirmation across Windows, macOS, and Linux.
- Clipboard copy, reasoning summaries, prompt drafts, long-thread refresh behavior, remote grant expiry, archived-conversation authority, and relay send boundaries remain owned by their exact current session.
- The Windows remote-vault regression test now drains its asynchronous pairing audit before checking durable state, matching the real service lifecycle and removing a platform-specific file-replacement race without changing runtime behavior.

### Release confidence

- Architecture and lint checks, four TypeScript projects, unit and integration coverage, portable provider contracts, remote-browser Electron E2E, production audit, encrypted-vault and protocol adversarial fixtures, three-OS packaging, package smoke, Electron fuse verification, checksums, and provenance protect the release.

## 0.0.17 — 2026-07-30

### Graphite Ink gives the workspace a calmer edge

- Dark mode now uses a near-black graphite canvas with clearer elevation, selection, focus, and muted-text contrast instead of a blue-leaning surface stack.
- Active agents communicate progress through a restrained animated identity-text wave rather than a detached status circle or broad loading wash.
- Code, diffs, inline code, and syntax tokens use a compact semantic palette that stays legible without turning the transcript into a rainbow.
- Light mode, forced colours, interface scaling, response density, and reduced-motion behavior retain explicit readable fallbacks.

### PDFs become real prompt context

- Images, PDFs, and supported documents can be pasted or attached, previewed at a useful size, removed, and sent without the composer becoming falsely blocked.
- Linux clipboard PDFs with missing MIME metadata are identified from their verified file content instead of being rejected before the prompt can run.
- Providers receive bounded text extracted from the exact privileged attachment claim; image paths remain image-only, and unsupported documents stay honestly identified rather than being relabeled.
- PDF extraction is limited by pages, time, dimensions, pixels, per-document text, and aggregate prompt context so an oversized or malformed document cannot monopolize the local runtime.

### Delivery and persistence stay authoritative

- Document preparation shares the bounded send deadline with route readiness, skills, Git context, and checkpoints. A timed-out or cancelled request releases its privileged attachment claims instead of leaking work in the background.
- Renderer and runtime deadlines leave enough room for ordinary PDF extraction while still failing with a specific, recoverable explanation.
- An append-only schema migration persists attachment execution-context references alongside existing file, diff, terminal, and review-note context, including upgrades from the released v0.0.16 database.
- Package smoke now exercises the shipped PDF worker and native canvas path, including known-text extraction, so Linux, macOS, and Windows artifacts validate the feature they distribute.

### Release confidence

- Architecture checks, lint, four TypeScript projects, 1,596 unit and integration tests, portable provider contracts, focused PDF Electron E2E, production dependency audit, exact-head Codex review, and green Linux, macOS, and Windows packaging gates protect the release.

## 0.0.16 — 2026-07-30

### A smaller application before the first conversation opens

- Initial renderer JavaScript falls from approximately 3.16 MiB to 609.2 KiB, while entry CSS falls from approximately 377 KiB to 276.1 KiB.
- Transcript, workspace tools, Activity Center, command palette, settings, dialogs, and terminal assets now load as focused deferred chunks instead of competing with the first secure window paint.
- Bundle budgets cap entry JavaScript, entry CSS, the deferred transcript chunk, and total renderer JavaScript so future features cannot silently undo the reduction.
- The secure window begins loading concurrently with private attachment reconciliation, and a narrow privileged readiness signal reconnects the renderer as soon as the supervised runtime is available.

### Long histories pay for what is visible

- Transcript virtualization now responds to message length, tool-detail size, activity volume, and compatibility-history weight, beginning at 14 ordinary rows or 10 already-heavy rows.
- Closed historical execution details leave the DOM, hot timeline and sidebar projections reuse stable inputs, and scroll-anchor restoration uses a cached target with a bounded 600 ms stabilization window.
- Streaming answers skip expensive syntax highlighting until settled. Oversized or unusually tall code remains safe readable text instead of monopolizing the renderer.
- Workspace tools, dialogs, trusted overlays, and terminal resources retain their focus, ownership, and native-preview suspension behavior across lazy-loading boundaries.

### Less background runtime and persistence churn

- Background snapshot invalidations coalesce over a bounded 32 ms window, while authoritative command acknowledgements and explicit lifecycle boundaries still flush immediately.
- Runtime replay no longer retains redundant complete snapshots, and reconnects continue through the existing authoritative fresh-hydration path.
- Conversation-detail reads use scoped ordering indexes and a windowed latest-turn query; streamed deltas no longer rewrite conversation timestamps on every append.
- Git-artifact reconciliation reads a narrow revision instead of constructing a complete application snapshot.
- SQLite uses WAL with `synchronous=NORMAL` intentionally: committed transactions remain crash-consistent, but the newest operating-system-buffered commits are not promised to survive sudden host power loss.

### Review and release confidence

- Native previews suspend from the always-loaded trusted status boundary before a deferred provider-auth dialog can appear.
- Window creation participates directly in the concurrent startup barrier so an early renderer or resource failure is observed immediately.
- Architecture checks, lint, four TypeScript projects, 1,573 unit and integration tests, 177 portable provider contracts, 40 Electron scenarios, production audit, renderer bundle budgets, and exact-head Linux, macOS, and Windows packaging gates protect the release.

## 0.0.15 — 2026-07-30

### Long conversations stay responsive

- Live provider activity now updates conversations through bounded shell, message, commentary, and run projections instead of repeatedly reloading the complete runtime snapshot and transcript.
- Timeline construction reuses stable message, plan, activity, and subagent inputs, estimates render weight incrementally, and limits elapsed clocks to visible active work.
- Historical execution details stay out of the DOM until opened, while activity-heavy conversations virtualize from their real content weight instead of waiting for a fixed turn count.
- Scroll-anchor restoration is time-bounded, and the long-conversation minimap previews each user request on hover or keyboard focus so distant turns are easier to recognize.

### Durable streaming with less write amplification

- Streaming commentary persists before it is shown, but coalesces appends on a measured 240 ms cadence instead of rewriting a growing message roughly every animation interval.
- Message, conversation, execution-ledger, workspace-run, and snapshot updates retain authoritative ordering across terminal settlement, renderer reconnects, follow-ups, and restart recovery.
- Live commentary, activities, subagent traces, and terminal text remain visible until authoritative detail has actually hydrated them, including when a refresh times out or disconnects.
- Approval and provider-question lifecycle changes project into an already loaded turn without replacing its transcript or restoring full-detail reload churn.

### Claude and Duo finish cleanly

- Claude SDK turns settle when the authoritative final result arrives instead of waiting indefinitely for optional idle behavior.
- Delegated Claude work tolerates roster and terminal-notification reordering, consumes the terminal edge when it exists, and uses bounded quiet and iterator-cleanup fallbacks when it does not.
- Follow-up messages stay inside the active turn without duplicating the visible assistant prefix.
- Duo setup has stronger hierarchy and contrast, clearer Route A and Route B ownership, and model palettes that remain visible and keyboard-operable outside their route cards.

### Small details remain truthful

- Persisted plans remain available in both primary and split Plan panels after hydration and unrelated shell updates.
- Historical attachments distinguish images, PDFs, and other documents instead of relabeling every attachment as an image.
- Saved prompt previews safely truncate long unbroken text while preserving the full prompt in an accessible tooltip.
- Failed background refreshes preserve the last ready conversation instead of replacing it with a passive “request took too long” reload state.

### Release confidence

- Architecture checks, lint, four TypeScript projects, unit and integration coverage, portable provider contracts, Electron E2E, production dependency audit, three-OS packaging, package smoke, Electron fuse verification, checksums, and provenance protect the release.

## 0.0.14 — 2026-07-29

### Two agent perspectives from one prompt

- A lightning action beside New chat configures exactly two independently named chats from one shared prompt, with a separate project, provider route, reasoning level, and access mode for each side.
- Duo reuses Inertia's real model chooser, readiness checks, conversation creation, and split-workspace ownership. Cross-project pairs keep independent files, Git review, terminals, plans, previews, approvals, questions, drafts, and provider sessions.
- An optional bounded default Duo stores only safe chat names and route identity. It never copies prompts, projects, credentials, provider options, or secrets, and warns when both agents will edit the same checkout.
- Partial creation and ambiguous delivery stay honest: an acknowledged survivor can continue, duplicate submission is blocked, and uncertain delivery requires an authoritative refresh instead of risking duplicate chats.

### Drafts and daily workspace flow

- Adding a project now opens a recoverable unpersisted draft immediately. Sidebar search shows only matching active conversations, long pasted requests can collapse without losing scroll position, and IME composition can no longer send accidentally.
- A bounded prompt stash keeps up to 12 unfinished text prompts with their exact safe route identity for later use in either split pane. Attachments and credentials deliberately remain outside the stash.
- Project-file references in answers open directly in Files. Supported text files can be edited in a focused dialog that verifies the content has not changed before saving.
- Expanded folders survive refresh when still present, nested repository changes remain scoped to their real repository, and workspace tools stay owned by the exact chat that requested them.

### Truthful goals, skills, and delegated agents

- Codex-native goals and Inertia-local objectives are persistent, separately attributed, reconnect-safe, and never injected or relabeled as one another.
- Codex and Claude skills are discovered through the selected route, attached only to the next turn, revalidated at the privileged execution boundary, and represented without exposing provider paths, contents, or credentials.
- Compact Codex and Claude subagent trees preserve provider-reported parentage, status, continuation, and terminal state. Guide parent prepares an ordinary parent follow-up; direct Stop appears only for supported live Claude tasks.
- Provider plans no longer open the Plan tab automatically. Goal and skill state remains independent across split chats, themes, narrow layouts, and keyboard navigation.

### Faster long conversations

- Conversation virtualization now considers estimated render weight, so activity-heavy histories no longer wait for a fixed 40-turn threshold. The reproduced 36-turn, 1,224-activity fixture mounts fewer than 24 timeline rows.
- Closed historical tool output and run details are unmounted instead of merely hidden. Large command payloads return only when their disclosure is opened.
- Streaming commentary uses a lightweight text path and a measured 240 ms persistence/projection cadence, then settles into full safe Markdown. A deterministic 100,000-character stream reduced persistence flushes from 98 to 7 without losing content.
- Stream updates persist before projection, batch message and conversation state transactionally, and flush at lifecycle and hydration boundaries so restart recovery and two-renderer exact-once delivery remain authoritative.
- A reproducible loopback WebSocket compression benchmark is now documented. `permessage-deflate` remains disabled until repeated cross-platform evidence shows that reduced snapshot bytes outweigh the CPU and memory cost.

### Clearer contrast and state

- Light and dark themes now share semantic contrast, border, selection, focus, disabled, and status-surface tokens across the transcript, composer, activity, sidebars, settings, model chooser, split workspaces, diffs, attachments, and notifications.
- Secondary text and boundaries are more readable without turning the interface into stacked panels. Hover, selection, focus, approvals, questions, warnings, failures, and success states remain distinguishable through text and shape as well as colour.
- Numeric WCAG regression coverage and refreshed original-resolution screenshots protect the intended contrast across interface scales and response densities.

### Reliability across providers, files, and Git

- Conversation-bound sends, imports, pickers, draft restoration, previews, Stop actions, provider callbacks, and delayed responses now retain exact ownership across rapid A → B → A navigation and cross-project split use.
- Git reversal is serialized per canonical repository, workspace traversal pins directory identities, and malformed, duplicated, empty, oversized, or unrepresentable provider interactions fail closed.
- OpenCode startup, authentication, requests, interactions, and cancellation are bounded per run. Codex App Server, Cursor ACP, one-shot CLI, maintenance, Git, and supervised-runtime process trees must be confirmed stopped before a terminal success or cancellation can settle; Claude SDK tasks use bounded interrupt/abort acknowledgement.
- Interrupted runtime projections reconcile atomically, packaged shutdown waits for runtime and attachment cleanup, and Windows process-tree handling uses explicit system executables and observable confirmation instead of trusting a launched kill command.

### Security and release confidence

- Filesystem and Git commands carry short-lived, owner- and purpose-bound secure-file authorities. Main revalidates containment, inode, mode, and digest at the operation boundary, while replacement journals preserve crash-safe recovery.
- Attachments remain opaque, privately stored, inode-pinned, content-verified, bounded, and lifecycle-owned. Native previews use isolated sessions and suspend before trusted overlays paint.
- Provider output, approvals, goals, skills, subagents, credentials, runtime capabilities, and diagnostics preserve their existing least-authority and redaction boundaries. Full Access remains the only explicit opt-in transfer of unrestricted provider authority.
- The final release candidate is gated by architecture and lint checks, four TypeScript projects, unit and integration tests, portable provider contracts, Electron E2E, production dependency audit, three-OS packaging, package smoke, Electron fuse verification, checksums, and provenance.

## 0.0.13 — 2026-07-28

### Two chats, two complete workspaces

- Any second chat can open beside the current one, even when it belongs to another project. Each pane keeps its own draft, provider route, transcript, files, Git review, changed-file context, terminal sessions, plan, preview, and actions.
- Split chats can be resized side by side or stacked in a narrow window. Promoting a chat changes only its visual position, preserving both conversations' terminals, previews, attachments, drafts, and provider context.
- Workspace tools move below each split chat so both projects retain usable height. Each pane remembers its own selected tool and size, while terminals stay alive after their first activation as the user moves between Changes, Files, Plan, and Preview.
- Conversation detail subscriptions, pending approvals and questions, delayed Git/files/review responses, reversible Undo handles, activity actions, and native preview requests now carry explicit pane ownership so closing or switching one project cannot lose its controls or replace or navigate the other.

### A useful workspace summary without permanent tool weight

- A compact Environment summary is the default workspace surface, bringing the current project, Git branch and changes, active work, delegated agents, and recent context into one calm disclosure.
- Files, Changes, Terminal, Plan, and Preview remain one click away but start compacted on a fresh install. Settings can restore the previous tools-first startup for users who prefer it.
- Activity now groups only the latest meaningful provider operations beneath the owning agent run, keeps manual source-control work independent, and leaves the complete bounded history available on demand.
- Provider-reported five-hour and weekly limits can notify at 25%, 15%, and 5% remaining. Notifications are route-scoped, deduplicated, freshness-aware, and remain silent when a provider does not report an authoritative quota.

### Attachments and previews that behave like desktop tools

- Pasted and selected images open in a larger accessible preview before sending, while PDFs have an embedded preview plus an explicit external fallback for Linux environments without a usable Chromium PDF viewer.
- Every pending attachment can still be removed individually. Clipboard MIME recovery, opaque attachment capabilities, digest verification, bounded reads, cleanup, and provider input ownership remain enforced.
- Two native project previews can run independently at once. Navigation, history, bounds, redirects, downloads, permissions, modal occlusion, conversation changes, and shutdown are now brokered by owner and conversation context.
- Closing Inertia destroys native previews before the supervised runtime settles, preserving live terminal sessions during normal use without delaying application shutdown.

### Release confidence

- The release candidate passes architecture checks, standard and type-aware lint, four TypeScript projects, 1,154 unit and integration tests, 114 portable provider tests, 37 Electron end-to-end scenarios, packaged-app smoke, Electron fuse verification, strict macOS bundle verification, and the production dependency audit.
- Cross-platform coverage includes wide and stacked split chats, different project roots, independent terminal IDs and working directories, dual native previews, attachment modal ownership, compact startup, quota thresholds, activity grouping, reconnect sequencing, and accessible focus restoration.

## 0.0.12 — 2026-07-28

### Faster evidence that a change is safe

- Renderer interaction tests now run in a real lightweight DOM, covering command-palette focus, filtering, selection and reset, global-shortcut ownership, delayed terminal focus, and disclosure lifecycles without waiting for a packaged desktop run.
- The Electron end-to-end gate keeps all 35 platform-level scenarios while splitting the former 5,552-line release spec into independently seeded feature suites for the shell, settings, workspace, palette, review, terminal, activity, layout, and transcript.
- Linux CI now measures every TypeScript source file—including files no test imports—and enforces conservative global and renderer coverage floors. macOS, Windows, and Linux continue to run the ordinary unit and packaged-app gates.
- Type-aware promise checks now catch floating, misused, and incorrectly awaited promises alongside the existing React hook and correctness rules.

### Guardrails that shape the repository

- Architecture validation now parses the complete source import graph—including dynamic imports with import attributes—resolves TypeScript aliases and runtime `.js` specifiers, rejects cycles and invalid layer direction, and derives compatibility-facade boundaries from structure instead of a growing path list.
- The runtime process protocol now lives in the shared Node layer used by Electron main and the supervised utility runtime, removing the last server-to-main dependency.
- Uniform source, test-case, and test-support ceilings replace hand-maintained per-file budgets, so a failing guardrail cannot be satisfied by appending another exception.
- Test TypeScript projects now cover the complete unit and Electron suites without hand-enumerating whichever renderer components a test happens to import.

### More predictable onboarding and provider maintenance

- Node.js 22 is declared for contributors, provider-facing SDK versions are exact, Dependabot handles routine dependency and GitHub Actions updates, and a secret-free weekly canary checks the latest Codex, product-shaped Claude configuration, Cursor, ACP, and OpenCode surfaces before provider drift reaches a release.
- The repository now includes private security-reporting guidance, privacy-aware bug and pull-request templates, a concise coding-agent guide, and a troubleshooting path built around Inertia's sanitized runtime diagnostic report.
- Package builds generate deterministic production-dependency notices and include Inertia, Electron, and Chromium license material with every desktop artifact.
- English-only interface dates, clocks, compact numbers, and quota reset labels now use one explicit locale instead of mixing English and operating-system formatting in the same view.

## 0.0.11 — 2026-07-28

### A foundation that is easier to change safely

- Codex App Server execution and backend-profile management now live in bounded protocol, event, configuration, lifecycle, discovery, and runtime modules instead of growing inside two giant files.
- The workspace scene, global shortcuts, update flow, review matching, runtime diagnostics, and provider controls have clearer ownership and smaller renderer update surfaces.
- Architecture checks now enforce production file and import ceilings, persistence cycle boundaries, React hook rules, and lint coverage for tests as part of the normal check.
- Database migrations use validated SQL identifiers, Git failure classification is locale-independent, and compatibility facades remain thin enough to preserve the existing V0.0.10 workflow and history.

### Large and rootless workspaces feel first-class

- Projects without a root Git repository can discover nested module repositories beyond the old 64-repository cutoff, report the true bounded result, and choose how many repositories to display.
- Nested repositories keep their own review marks, notes, questions, selective reverts, stale-target reconciliation, and repository identity throughout the review flow.
- Large repositories load a selected file's diff directly while still validating its fingerprint against the complete repository state; nested review marks can no longer satisfy a root commit warning accidentally.
- Automatic checkpoints preserve sparse-checkout boundaries, ignored files, staged index content, exact working-tree bytes, and unusual paths without running repository clean/smudge filters or reference hooks.

### Calmer cross-platform work

- Windows transcript spacing and model-selection geometry, Linux streaming-caret placement and readability, composer breathing room, and narrow layouts received another platform-specific pass.
- Settled transcript rows keep stable identities, background work animation pauses when the window is inactive, and tool activity remains smooth during long or rapidly updating runs.
- Supported provider CLI updates and Inertia release notices remain visible through reconnects without duplicating an operation or installing anything silently.
- Full Access is documented as the provider-level safety bypass it is, including Codex's unrestricted sandbox/approval configuration and Claude's permission-skipping mode.

### Security and release confidence

- Automatic Git inspection disables repository-controlled filesystem monitors, external diff drivers, text conversion, executable filters, and hooks while preserving ordinary explicit Git workflows.
- Embedded previews accept only literal loopback origins; remote HTTPS links open externally, and attachment previews revalidate ownership, containment, type, size, and content digest before returning exact bytes.
- Signing credentials are scoped only to their matching release runner, support reports retain their newest bounded diagnostics, and local security reports remain outside the repository.
- The final release candidate passed architecture checks, lint, typecheck, 1,070 unit and integration tests, 114 portable provider tests, 35 Electron end-to-end tests, production dependency audit, native package smoke, Electron fuse verification, and macOS bundle verification across macOS arm64, Windows x64, and Linux x64.

## 0.0.10 — 2026-07-27

### A stronger foundation without changing the workflow

- Inertia's largest renderer, runtime, database, Git, transcript, composer, provider, and shared-contract files are now split into focused modules with clear ownership.
- Compatibility boundaries preserve the behavior and stored history from 0.0.9 while making individual features easier to understand, test, and change safely.
- New architecture checks catch oversized core files, dependency cycles, misplaced command ownership, and accidental imports through compatibility facades before they reach a release.
- Persistence migrations and repositories now live in explicit domains, keeping projects, conversations, turns, usage, Git artifacts, reviews, provider metadata, settings, and recovery state independently testable.

### Smoother daily work across every platform

- Model Favorites now save the useful route as one preset—including harness, backend, model, and reasoning—while the chooser opens directly on those choices instead of an unnecessary All view.
- Provider setup can detect supported CLI updates, explain the official update route, run it inside Inertia, show bounded progress, and keep the operation available after a renderer reconnect.
- Windows transcript spacing, model-row hover geometry, first-message readiness, Linux readability, composer breathing room, and narrow-layout behavior received a focused cross-platform pass.
- Tool activity keeps its restrained workstream presentation with lower-cost animation and more stable scroll anchoring during long or rapidly updating runs.
- Initial Git refresh failures are now reported instead of leaving an unexplained empty Changes view, and recursive Files refreshes no longer retain stale nested folders.

### Safer attachments and more reliable lifecycles

- Pasted and selected attachments now cross the renderer boundary as opaque capabilities rather than arbitrary paths. The runtime independently verifies the app-owned location, identity, type, size, and content digest before a provider can use them.
- Attachment ownership follows renderer, runtime, retry, cancellation, restart, and shutdown lifecycles so removed or orphaned files cannot silently escape the retained-storage limit.
- Provider completion settles and reaches the interface before optional Git capture or attachment cleanup, so Stop and working states disappear when the provider actually finishes.
- Active provider updates survive reconnects, rejected submissions keep safe retry ownership, and interrupted runtime cleanup remains conservative until process exit is confirmed.

### Release confidence

- Architecture checks, linting, typecheck, 1,002 unit tests, 113 portable provider tests, 35 Electron end-to-end tests, packaged-app smoke tests, Electron fuse verification, dependency auditing, and strict macOS bundle verification protect the release.
- Linux x64, Windows x64, and macOS arm64 continue to build from the exact release tag with checksums and build-provenance attestations.

## 0.0.9 — 2026-07-27

### A minimal workstream instead of stacked chat panels

- The conversation now reads like a calm engineering document: a lightly tinted request, chronological agent commentary, compact operational activity, a clean final answer, and quiet supporting details.
- Commentary continues to break tool activity into its real sequences. Adjacent calls can fold together without reordering work or hiding failures, warnings, approvals, or provider questions.
- Successful historical turns no longer repeat a prominent `Worked for…` row above every answer. Status, duration, copy, and run details settle into the answer footer while important exceptional work remains visible.
- Raw command output and large diagnostics stay inside bounded execution details instead of taking over the primary transcript. Interrupted transport work is distinguished from a genuine provider or tool failure.
- Active work uses a restrained motion-aware wash, while completed history remains static and reduced-motion preferences are respected.

### One composer, faster model and context choices

- The composer is now one cohesive bottom dock with the multiline prompt, attachments, model, reasoning, access, mode, context, and Send or Stop controls sharing one restrained surface.
- The selected model opens an anchored searchable palette with provider and harness filters, favorites, keyboard navigation, compatibility explanations, and truthful backend identity.
- Incompatible harness, backend, endpoint, or configuration changes still require a clearly explained new chat, so a provider session is never presented as transferred between routes.
- Context and usage now live behind one compact circular control. The popover separates context occupancy, processed tokens, quotas, reset timing, freshness, and unavailable provider data without borrowing limits from another backend.
- Pasted or uploaded images and documents receive secure previews before sending and can be removed individually. Validation, bounded reads, project-path rules, and cleanup remain enforced.

### Real projects, repositories, and delegated work

- Files can be explored recursively with lazy folder loading, project-wide search, keyboard tree navigation, safe previews, and refreshes that invalidate stale nested listings.
- Changes discovers bounded nested Git repositories, groups their modified files by real repository identity, and keeps the review surface compact when workspace tools are narrow.
- Expected non-Git workspaces no longer receive noisy turn-artifact warnings, while partial, expired, truncated, or genuinely failed history remains honest.
- Project rows include a quick New chat action without restoring the repetitive sidebar entry points removed in earlier releases.
- Claude delegation and provider subagent activity remain connected to the parent turn. Follow-up messages stay inside the authoritative active turn, and supported usage information continues to update without implying that context transfers between agents.

### Faster settlement and stronger heavy-run recovery

- A turn stops appearing active as soon as its provider reaches a terminal result. Git artifact capture can finish separately without leaving Stop or the working animation on screen.
- Build mode now encourages direct, action-biased execution while preserving investigation, approvals, sandboxing, recovery, and Plan mode.
- Codex App Server transport accepts safely bounded larger protocol messages, keeps aggregate output limits, classifies process and protocol interruptions, and retains sanitized technical details for diagnosis.
- Cross-platform coverage now exercises the complete Minimal Workstream, composer, model chooser, context control, attachments, delegated agents, recursive files, nested Git repositories, transport cleanup, responsive layouts, accessibility, packaging, Electron fuses, and native app smoke.

## 0.0.8 — 2026-07-26

### A conversation that follows the work

- Provider commentary and tool activity now appear in the order they actually happened, so the transcript can show an update, the calls it led to, the next update, and the final answer as one understandable sequence.
- Only adjacent calls are grouped. Commentary naturally separates one stretch of work from the next, while failed, cancelled, waiting, or important actions stay visible.
- Streaming prose remains visibly in progress and is promoted to the final answer only when the turn settles, preventing an early update from being mistaken for the completed response.
- Completed work folds into a lighter elapsed-time and action summary without turning the conversation into a stack of panels.
- Requests, approvals, provider questions, plans, reasoning summaries, execution details, checkpoints, and Git artifacts keep their established place in the turn.

### Calmer at every transcript size

- Long conversations use more accurate virtual row estimates for Markdown, code, tables, activity groups, narrow layouts, and expanded details.
- Scroll anchoring, jump-to-latest behavior, keyboard turn navigation, reduced-motion preferences, and live-region announcements remain stable while streamed content changes height.
- Responsive coverage now validates wide, stacked, and compact workspaces as well as long transcripts, streaming answers, grouped activity, settled work, motion preferences, and accessible labels.
- The main workspace, light theme, search palette, and README screenshots received a fresh visual validation pass.

### Release confidence

- The complete typecheck, unit, provider protocol, end-to-end, packaged-app, Electron-fuse, and macOS signature checks run against the release candidate.
- A repository-wide threat model and framework-specific security review found no critical or high-severity implementation defect. Security reports remain outside the repository.
- Production dependencies audit clean. A transitive advisory remains limited to the build-only packaging toolchain while the project waits for a compatible upstream fix rather than forcing an unsafe downgrade or override.

## 0.0.7 — 2026-07-26

### Trustworthy history for every agent request

- Every request now has a durable turn record with its original agent harness, model backend, model, lifecycle, and terminal result instead of reconstructing identity from the latest conversation state.
- Read-only answers about selected diff lines stay beside the matching hunk with their exact backend and model attribution instead of becoming ordinary conversation history.
- Legacy and interrupted work is recovered honestly. Missing attribution or incomplete repository history remains visibly unavailable or partial rather than being guessed.
- In Git workspaces, Inertia records before-and-after repository snapshots for each turn and stores a bounded, content-addressed patch. Historical changes can be opened and compared after later edits or a restart without reading the current working tree as if it were the past.
- Repository and worktree identity are checked across capture. Truncated patches, missing snapshots, moved worktrees, and failed captures preserve their real completeness state.
- Conversation lists now load authoritative lightweight metadata separately from heavier message, activity, plan, checkpoint, and Git-artifact detail. Stale detail responses cannot replace the conversation currently being viewed.
- Runtime mutations carry an ordered sequence cursor. Reconnects replay only committed updates after that cursor, while generation changes fall back to a complete snapshot without duplicating work.
- Stable transcript rows and incremental projection keep histories with hundreds of turns and thousands of messages responsive, including after runtime restart and recovery.

### Explicit model backends without hidden context transfer

- Agent harness, model backend, and model selection are now separate parts of one authoritative execution route. Native providers continue to use their own backend unless an explicitly compatible profile is selected.
- Settings can create, validate, probe, enable, disable, and choose custom backend profiles with explicit endpoints, authentication, model catalogs, context windows, and Claude tier routing.
- Plain HTTP is rejected except for exact loopback development endpoints. Unsafe URLs, malformed models, incompatible harness and protocol pairs, stale probes, and ambiguous defaults are rejected before launch.
- Custom backend credentials are encrypted through macOS Keychain, Windows DPAPI, or Linux Secret Service and never stored in the application database. Credential generations prevent a replaced or deleted secret from being confused with an earlier execution route.
- The built-in Kimi coding profile runs only through the verified Claude harness route and accepts only its supported endpoint, model IDs, and documented context choices.
- Existing conversations retain their original route even if a profile is edited or removed. Supported model changes on the same backend may continue in place; changing harnesses, backends, endpoint identity, configuration revision, or credential generation requires a clearly separated new chat.
- Backend launch environments are scoped per run so concurrent native and custom sessions do not inherit one another's endpoints, models, or credentials.

### Restart, migration, and release confidence

- Database migrations now preserve authoritative turns, execution identity, runtime sequencing, backend profiles, and historical Git artifacts while retaining the full fixture chain from earlier releases.
- SQLite write failures do not consume sequence numbers or expose partial runtime mutations, and credential failures stay contained to the affected backend.
- Coverage now includes long-history projection, restart and replay, turn-artifact persistence, profile deletion history, credential isolation, route boundaries, custom Codex backends, Kimi through Claude, and concurrent backend launch isolation.
- Cross-platform contracts continue to validate Windows Codex discovery, Linux package identity and resources, hardened Electron fuses, packaged-app startup, and exact-tag release assets without adding another agent provider or changing application identity.

## 0.0.6 — 2026-07-23

### A clearer way into every project

- Fresh installs now open directly on the project picker instead of creating an example project and conversation.
- Each project has one consistent New chat entry point. The empty project view explains the next step without repeating the same action throughout the sidebar.
- Project navigation now separates Projects from Work: Projects keeps the repository tree calm, while Work prioritizes conversations that need attention, active runs, and a bounded recent history.
- Completed background work, unread results, settled threads, archived conversations, and failures are easier to distinguish without leaving permanent noise behind.
- Search, keyboard navigation, focus handling, and compact drawer behavior remain predictable across both navigation modes.

### Agent work that is easier to follow

- Live reasoning and tool activity now read as one compact provider run, followed by a clearly separated final answer.
- Completed activity can fold into a quiet summary while failed, cancelled, waiting, or important work remains visible.
- The Runs surface prioritizes approvals and provider questions before active and recent work, with only the actions each run can actually perform.
- Conversations keep the provider they started with after the first message. Switching to a different agent now requires a new chat so provider-owned context is never implied to transfer.
- Usage presentation responds more carefully to the available space and to whether the provider has supplied a meaningful report.

### Smoother desktop behavior

- Windows and macOS resolve the saved or system theme before the first visible paint, reducing mismatched background flashes while the renderer starts.
- Native window backgrounds use only validated cached theme values and safely fall back when that cache is missing or invalid.
- Sidebar transitions, titlebar spacing, composer controls, panel boundaries, and agent transcript density received another responsive pass.
- End-to-end coverage now starts from a genuinely empty installation and exercises project creation, Projects and Work navigation, prioritized runs, theme bootstrap, and common workspace sizes.
- The cross-platform suite also verifies Windows Codex discovery through safe Unicode npm shims and keeps timing-sensitive macOS layout checks isolated from later tests.

## 0.0.5 — 2026-07-23

### Review changes with confidence

- Changes is now a complete review workspace with per-file navigation, insertion and deletion totals, line wrapping, whitespace filtering, and a layout that remains usable in narrow side panels.
- Select one line or a range and ask a read-only question, request a focused revision, save a local note, or add the exact selection to the next prompt.
- Review questions always run in a fresh read-only agent turn, even when the main conversation is in Build mode with Full Access.
- Selected revisions create a recovery checkpoint first and clearly explain that the selection is the requested focus rather than an unsafe promise that surrounding code can never be touched.
- Selective revert now handles staged, unstaged, and mixed changes without discarding unrelated work. It revalidates the complete diff, file, hunk, selected lines, and both Git layers before writing.
- Every selective revert creates an immediate recovery backup and offers Undo. Undo refuses to overwrite later file or index changes.
- Line endings, final newlines, executable permissions, and the distinction between staged and working-tree content are preserved.
- Conflicts, renamed or deleted files, untracked files, symbolic-link type changes, binary content, stale selections, and truncated diffs are rejected honestly when a safe line-level reversal cannot be guaranteed.
- Agent-generated change summaries cover every current file and hunk in an isolated, tool-free review session. Compact hints flag visible behavior, regression, security, migration, test, performance, or documentation concerns without presenting them as established facts.
- Review summaries are discarded if the diff changes while they are running. Oversized, incomplete, duplicated, malformed, or timed-out results are never saved.
- Files and hunks can be marked reviewed, filtered by review state, and navigated with Previous and Next controls. Review progress persists across restarts and becomes stale when its target changes.
- Local notes can be attached to a file, hunk, or selected lines, edited later, returned to the prompt, or used to request a revision. Changed targets keep their note but mark it stale.
- The commit dialog can stage and commit only checked paths, preserves unrelated staged work, and warns when selected hunks have not been reviewed.

### Conversations that stay readable

- Assistant responses now render safe GitHub-flavored Markdown with headings, lists, task lists, links, tables, and fenced code.
- Code blocks support syntax highlighting, per-block wrapping, and one-click copy. Tables can be copied as Markdown or CSV.
- External links open outside Inertia, project-file links open through the local desktop bridge, and unsafe HTML, protocols, path traversal, and escaping file links are blocked.
- Streaming responses remain structurally stable while a code fence is still being written and switch to highlighting only when it is safe.
- Each user request, reasoning summary, tool activity, approval, question, system message, final answer, and recovery checkpoint is grouped into one chronological turn.
- Successful tool work can collapse into a quiet elapsed-time summary, while failures, cancellations, unsupported actions, and important warnings remain visible.
- The latest settled turn can show a current changed-file summary, and any answer can be copied directly.
- Transcript following no longer pulls the view away while reading older work; a Jump to latest control appears instead.
- Response density, default code wrapping, completed-work collapsing, changed-file summaries, timestamps, and live thinking visibility now persist as preferences.

### Activity-first projects and workspace control

- A new Activity Center groups agents, checks, services, and source-control work with live elapsed time and clear running, waiting, completed, stopped, and failed states.
- Waiting work distinguishes an approval from a provider question. Supported actions include opening the thread, folder, terminal, or service preview, plus stop, retry, rerun, failure details, and dismiss.
- Activity survives restarts, while interrupted runs are recovered without pretending their old processes are still stoppable.
- Project navigation now offers Classic and Activity-first modes. Active, waiting, failed, completed, unread, settled, and archived work remain visually distinct.
- Completed background work gains an unread marker until visited. Finished threads can be settled into history, restored to active work, archived, renamed, or deleted when safe.
- Projects are grouped using canonical Git identity and repository-relative paths rather than matching display names. Repository, repository-plus-folder, and separate grouping modes are available globally and per project.
- Search and keyboard navigation work across the new project and activity models, including wrapping arrow navigation and Home/End movement.
- Turn checkpoints can restore the project to its state before that request after active work has stopped.

### Provider behavior, usage, and setup

- Approvals, questions, plans, cancellation, activity, and failure handling now share one provider-neutral contract while retaining each provider's real capabilities.
- Codex, Claude, Cursor, and OpenCode interactions update existing lifecycle records instead of producing duplicate activity rows.
- A provider known to be unavailable is rejected before a user turn is persisted, then refreshed so the visible setup state remains accurate.
- Provider authentication runs in an owned terminal and refreshes installation, account, model, and capability state when it exits.
- Windows Codex discovery now checks official standalone installs, custom Codex locations, npm, pnpm, Bun, Volta, PATH, and `where.exe`, validates candidates, and selects a working executable.
- Windows command shims support Unicode paths, spaces, and parentheses without enabling generic shell execution or treating arguments as command text. A manually selected Codex executable always takes precedence.
- Settings show the selected Codex executable, allow a validated manual override, and report installation, sign-in, and App Server support separately.
- Usage can be expanded, compact, or hidden. Context occupancy, provider-defined processed-token totals, quota windows, reset timing, freshness, and cached provenance remain distinct.
- Missing or zero context limits, unavailable quotas, stale refreshes, and out-of-range provider values are shown honestly instead of producing invented capacity or misleading meters.

### Desktop polish, privacy, and release reliability

- The composer gained cleaner cascading menus for project actions, providers, models, reasoning, mode, and access. Menus dismiss on outside click or Escape without forcing a selection.
- Selected diff context and image attachments remain visible before sending, with clear removal controls and enforcement of the real message-size limit.
- Interface scale now supports Compact, Default, Comfortable, and Large across navigation, messages, controls, files, and diffs, independently from terminal text size.
- The visible Light/Dark quick toggle, System theme behavior, panel boundaries, narrow layouts, send-button containment, request cards, commit-dialog focus, and macOS titlebar branding received another responsive pass.
- Local runtime diagnostics record only bounded lifecycle and failure metadata. Prompts, source, token values, credentials, capabilities, and raw local paths are excluded or redacted.
- Diagnostic files use private permissions, rotate at 256 KB, expire after seven days, and can be revealed from Settings without affecting app startup if logging fails.
- The app preserves canonical project identity, review state, notes, response preferences, activity, provider sessions, streamed answers, plans, reasoning, usage, and metadata through database migrations and restarts.
- Application icons now come from one deterministic vector mark with complete platform sizes. Linux packages validate desktop identity, icons, scaling behavior, and the bundled runtime resource.
- CI and exact-tag releases exercise macOS arm64, Windows x64, and Linux x64 with locked installs, typechecks, unit and provider protocol suites, Electron end-to-end tests, dependency auditing, native packaging, hardened Electron fuse checks, and packaged-app smoke tests.
- Release publication revalidates the exact tag, verifies platform assets, preserves the complete macOS signature, normalizes the Windows installer name, publishes checksums without replacing existing files, and records build provenance attestations.

## 0.0.4 — 2026-07-22

### First-class provider runtimes

- Codex conversations now use the versioned app-server protocol in every access mode instead of falling back to the legacy CLI path.
- Claude, Cursor, and OpenCode now run through their native SDK or ACP integrations, with provider-owned sessions, streaming, approvals, questions, plans, reasoning, usage, attachments, model choices, and cancellation when supported.
- Provider-specific capabilities are explicit, so an unavailable feature is reported honestly instead of being silently emulated by another runtime.
- Usage accounting now preserves each provider's real scope: context occupancy, run totals, session totals, or thread totals are no longer presented as interchangeable values.

### A resilient local runtime

- Database, terminal, WebSocket, and provider work now live in a supervised Electron utility process instead of the main process.
- If that runtime crashes, Inertia keeps the window open, rotates its local connection capability, recovers interrupted work safely, and reconnects without duplicating a live worker.
- App shutdown now gives active providers time to cancel, escalates boundedly when a worker is unresponsive, and finishes through Electron's normal quit lifecycle.
- Native modules remain outside ASAR where required, while hardened Electron fuses and complete-bundle signature checks remain enforced for packaged builds.

### Metadata, interface, and release reliability

- Models, reasoning options, account limits, provider versions, and authentication state now refresh through a correlated persistent cache without presenting stale values as live.
- Usage controls stay out of the way until a provider has actually reported usage or quota data.
- Composer menus now dismiss on outside click or Escape, restore focus predictably, and preserve the current choice until a new one is selected.
- Global shortcuts now remain available while the terminal is focused, including Command Palette on Windows and Linux.
- Command Palette actions now resolve against the latest typed query, even when Enter follows input immediately on a slower desktop.
- Permission prompts now present clean native filesystem paths on Windows instead of mixed path separators.
- The frameless macOS titlebar now carries a larger, compact Inertia mark with deliberate clearance from the native window controls.
- CI now exercises Linux x64, Windows x64, and macOS arm64 with portable provider fixtures, Electron E2E coverage, dependency audits, native package smoke tests, signature and fuse checks, and exact non-clobbering release assets with attestations.

## 0.0.3 — 2026-07-22

### A more aware agent workspace

- Model and reasoning choices now come from the connected provider instead of a fixed list.
- Codex thinking summaries can appear live and remain with the conversation after a restart.
- The composer shows remaining context and account usage, including reset timing when the provider reports it.
- Provider usage is refreshed after each run so the display does not quietly go stale.

### More room to work

- Command search now covers actions, projects, and threads with full keyboard navigation.
- The project sidebar and workspace tools can both collapse, reopen, and remember their state.
- Existing panel resizers remain available, with clearer but restrained visual boundaries.
- Wide, stacked, and compact layouts received another overlap and navigation pass.

### Settings and reliability

- Settings now have focused sections for general preferences, providers, source control, keybindings, and local data.
- New controls cover thinking summaries, usage visibility, plan behavior, destructive-action confirmation, and conversation defaults.
- Provider reasoning, usage, and settings state now survive restarts through the local database.
- Desktop tests now cover search, panel persistence, settings navigation, resizers, tool tabs, previews, and multiple window sizes.
- macOS community packages now receive complete-bundle ad-hoc signing after Electron security fuses are applied, preventing an invalid-signature launch failure.

## 0.0.2 — 2026-07-22

- Connected the workspace to real local coding-agent accounts, beginning with the Codex app-server flow.
- Added streaming conversations, resumable sessions, plans, approvals, agent questions, and persistent conversation state.
- Added provider setup, resizable workspace panels, restrained glass styling, and light, dark, and system themes.
- Published native downloads for macOS, Windows, and Linux.

## 0.0.1 — 2026-07-22

- Established Inertia's Electron workspace, project navigation, conversation layout, Git tools, file browser, preview, and terminal foundation.
