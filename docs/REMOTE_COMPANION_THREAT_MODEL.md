# Remote Companion threat model

## Scope and recommendation

Remote viewing and text prompting can fit Inertia's trust model only with the
desktop remaining online and authoritative, outbound-only transport, explicit
device pairing, end-to-end encrypted application frames, narrow runtime
commands, and the remote capability exclusions in
`REMOTE_COMPANION_PROTOCOL.md`.

The implemented recommendation is an opt-in companion using an opaque relay.
The included relay/browser are reference and local/self-hosting components,
not production infrastructure. The no-go option is to leave Remote Companion
disabled or remove it from a build. A direct LAN listener is a no-go under the
approved outbound-only boundary.

## Assets and trust boundaries

Protected assets:

- provider credentials and secret answers;
- host/device private keys and pairing secrets;
- raw local runtime capabilities;
- source, filesystem paths, attachments, diagnostics, terminal and Git state;
- project/conversation/run identity and authorization;
- prompt text and safe transcript plaintext;
- local approval policy, sandbox mode, and provider routing;
- delivery/revocation/audit integrity and the user's working tree.

Trust boundaries:

1. Untrusted browser UI and its potentially stolen local profile.
2. Untrusted browser-delivery origin and web supply chain.
3. Untrusted network and relay.
4. Privileged Electron main and encrypted platform storage.
5. Strict main-to-utility-process protocol.
6. Local runtime persistence/provider/sandbox/approval authority.
7. Untrusted provider/Markdown/project output projected back to the browser.

The relay, browser device, provider output, project content, and every remote
request are attacker-controlled inputs. Electron main and the local runtime are
trusted only within their existing responsibilities.

## Attacker capabilities and abuse cases

| Threat | Consequence | Mitigation and residual risk |
| --- | --- | --- |
| Relay compromise | Observe metadata, replay/reorder/drop frames, deny service, impersonate routing endpoints. | HPKE E2EE/authentication, transcript-bound IDs/AAD/sequences, used-session ledger, exact schemas, no relay queue. Traffic analysis and denial remain possible. |
| Stolen browser/device | Attacker reads its IndexedDB key and can use the device's current projects/scopes until expiry or revocation. | Device-specific short grants, desktop-authoritative grant reduction, immediate local revocation, audit/active indicator, no credentials/files/approvals. Browser storage is not a hardware vault; this residual risk must be disclosed. |
| Desktop/account takeover | Attacker controlling the unlocked desktop can enable or approve access. A future hosted account could be taken over. | Local comparison and explicit approval; screen-lock pause; no hosted account exists in this MVP. A hosted service would require strong account recovery/MFA/session controls and is a separate decision. |
| Pairing phishing or invitation theft | Attacker submits an invalid or attacker device key using a copied five-minute invitation, or deliberately consumes it. | Random PSK, short expiry, attempt limits, one-time consumption before crypto, authenticated response, six-digit code derived from both keys and invitation, local comparison, sanitized device label, explicit project choice, and P-256 key import before any durable grant/audit mutation. Six digits require human verification and are not sole authentication. An invitation holder can force the local user to create a new invitation, but cannot create parallel approvals from one invitation. |
| Control/bidi device-label spoofing | Approval list could visually impersonate another browser or reorder text. | Main-process NFKC normalization removes controls and bidi override/isolate marks before pending state or persistence. |
| Pairing replay | Reuse an invitation/request, retain one across disable/re-enable, or race copies across relay routes. | One live invitation consumed synchronously before decryption and cleared on disable, one pending approval, five-minute expiry, bounded request-ID replay set, strict request/invitation correlation, local approval. Re-pairing an existing device closes every old session after the replacement grant is durable. |
| Session replay/fixation | Reuse a valid opening, race the same ID across routes, over-admit while crypto/persistence awaits, retain an opening across local revocation, force sequence reuse, or pin an old grant. | Fresh UUID/timestamp, atomic global session-ID/capacity reservation before crypto, release on failure/disconnect/grant change, persisted used-session IDs, HPKE authenticated context bound to host/device/session, exact sequence, desktop current grant returned encrypted. |
| Authentication CPU exhaustion | Repeated invalid openings trigger P-256 work across device keys. | Four attempts per relay connection, 24/minute global budget before crypto, at most 16 device keys, relay connection/message limits. Distributed relay/network DoS remains possible. |
| Malicious project/provider output | XSS, deceptive links, control/bidi transcript reordering, secret/path/source exfiltration, interrupted code/HTML blocks, oversized responses. | Projected content replaces C0/DEL controls except tab/newline/carriage return and bidi override/isolate marks before redaction, so omission markers cannot be visually relocated. Safe projection only, bounded monotonic removal of backtick/tilde fenced, unterminated, and top-level indented code plus paired/nested/self-closing/interrupted HTML; arbitrary POSIX, drive-letter, UNC, extended/device-namespace, and file-URL redaction; credential redaction; user/assistant roles only; UTF-8 byte budget; strict schemas/CSP; DOM `textContent`; no Markdown/HTML execution. Ordinary HTTP(S) URLs, angle-bracket prose, escaped prose, and surrounding punctuation remain usable. Heuristic redaction cannot prove arbitrary prose contains no secret. |
| Remote approval abuse | Prompt induces a Full Access, command, destructive, credential, or secret approval remotely, or local authority widens while provider readiness awaits. | Remote protocol has no approval/answer capability. Runtime prepare checks before/after readiness but cannot queue. Main revalidates the exact live session/device grant and synchronously posts a one-time commit; runtime consumes it, rechecks, and synchronously queues. Browser only reports that local action is needed. |
| Prompt/attachment/source leakage | Relay/browser receives sensitive local input, source, attachments, path, or execution payload. | Only explicit remote prompt text and safe projections cross the boundary. No attachment/path/source/diagnostic fields exist in strict schemas. Provider credentials and local capabilities never enter them. |
| Metadata leakage | Relay learns endpoint/IP/timing/size and opaque frame identifiers. | Minimal routing fields, no clear device ID on session opening, no payload logs/queue. Padding, anonymity, and traffic-shape hiding are not provided. |
| Browser profile corruption | Malformed IndexedDB changes relay URL, key, or grant. | Strict schema before use, WSS/loopback-WS transport policy, invalid profile deletion and explicit error. |
| Browser clickjacking/typejacking | An attacker frames an already paired browser and induces a prompt or navigation. | The reference Vite development/preview server sends `frame-ancestors 'none'` in the HTTP CSP response header. The meta policy does not claim unsupported frame protection. Self-hosting instructions require verifying an equivalent production response header; a misconfigured or compromised browser origin remains a trusted-delivery failure. |
| Browser attempt/poll race | Stale pair/reconnect overwrites a newer socket/session, leaves listeners alive, selection creates duplicate polling loops, or a stale prompt form targets the prior conversation. | Monotonic attempt and poll-generation ownership, one replaceable poll timer, synchronous detail/form clearing on selection/offline, prompt target equality with the current selection, tracked opening sockets, stale tunnel close, ownership checks after awaits, complete timer/listener cleanup on close/error/timeout. |
| Archived conversation authority | A conversation hidden from the safe shell remains selected, readable, or promptable after the local user archives it. | Runtime detail returns `not-found` for archived conversations. Prompt preparation checks before and after readiness, and commit checks again synchronously; all reject archived state until a fresh flow after unarchive. A current browser `not-found` clears transcript and prompt controls, while stale responses cannot clear a newer selection. |
| Relay peer-disconnect spoofing | Third connection closes another browser/desktop pair. | Relay verifies the caller owns the connection before disconnecting it. |
| Relay endpoint squatting | A party that learns an `endpointId` registers it first and keeps the legitimate desktop permanently offline. | Registration is restricted to sockets that present no Origin, and desktop retries use bounded backoff, but reference-relay registration proves no host-key possession. A holder of the endpoint denies service for as long as it keeps the socket. `endpointId` values must be treated as secrets and the relay kept off untrusted networks. Closing this requires a host-key registration challenge and a protocol version change. |
| Relay origin allowlist bypass | A non-browser client omits `Origin` and reaches the relay despite a configured allowlist. | Browsers always send `Origin`; the allowlist is enforced at upgrade and again on `relay.connect`, and origin-bearing sockets cannot register as desktops. The allowlist bounds browser delivery origins only and is not authentication. Application frames stay HPKE-sealed, so a bypassing client sees opaque frames and consumes bounded capacity. |
| Relay route lifecycle race | Disconnect or connection-ID reuse lands during asynchronous pairing/session crypto and later commits approval/session state for a dead route. | `peer-connected` creates a desktop-local epoch; disconnect invalidates it synchronously and cleanup is ordered with the per-route frame queue. Post-crypto/persistence commits recheck epoch ownership. Active routes and queued frames are bounded. |
| Concurrent encrypted frames | Parallel `session.data` opens race HPKE recipient sequence and falsely close a valid session as replay; parallel responses race sender sequence. | One bounded inbound queue per route serializes frame opening only; validated runtime requests remain concurrent. A separate per-session outbound queue seals responses in completion order. |
| Denial of service | Oversized/malformed frames, unbounded pre-auth JSON parsing, connection churn, queued-frame or relay outbound-buffer growth, stalled close, large workspace, reconnect storm. | Desktop and every browser setup/handshake/active listener enforce the 132 KiB UTF-8 relay-envelope bound before JSON parse and close on oversized/non-text input. Serialized encrypted frames are capped at 130 KiB and plaintext projections at 96 KiB, with maximum-size seal/wrap/relay/open coverage. Layered count/rate/time limits include 240 messages/minute per browser socket and a 544-message aggregate desktop allowance for four independently capped sessions plus lifecycle traffic, eight active peer-route and 16-frame-per-route caps, a 264 KiB default per-destination relay send-buffer bound with termination, byte-bounded projections, no compression, exponential capped reconnect, heartbeat, and bounded 1.5-second shutdown then terminate. A relay or network can always make the optional feature unavailable. |
| Stale/offline state | Browser displays old state, duplicates a prompt after uncertainty, or the desktop remains stuck after a relay rejects a duplicate endpoint owner. | Generated timestamps, two-second live polling only while authenticated, clear offline status, no relay prompt queue, persisted dispatch receipt, no automatic prompt retry. Known failure before commit posting removes the receipt; only a posted commit with no acknowledgement is uncertain. A duplicate-endpoint capacity response closes the rejected socket and schedules bounded reconnect. A displayed projection may be up to one poll old. |
| Revocation/authority race | A prompt prepared under an old enabled, unlocked, device/project/scope grant queues after disable, lock, revoke, or reduction; a stale preparation is committed by retry. | Grant change/revoke increments desktop version and closes sessions. Main synchronously revalidates exact live authority immediately before the successful commit post, which is the delivery linearization. Issued runtime preparation IDs are one-time and expire in 15 seconds; issued plus in-progress operations are capped at 32, with an unresolved check retaining its slot. Same-request retry invalidates the old ID. Runtime consumes and rechecks before synchronous queueing. |
| Device-record exhaustion | Repeated revoked/expired pairings exceed the encrypted store's strict 16-record schema or block legitimate replacement. | The cap is 16 total records. Before appending, only the oldest retired revoked/expired records are deterministically pruned; 16 current devices reject without mutating durable state. |
| Lock during startup | A persisted enabled profile connects while already locked, while secure-store initialization awaits, or after a lock races the initial state sample. | The monitor starts locked, subscribes before sampling, treats reported `locked`/`unknown` as locked, retains events that race the sample, and applies state before explicit connection startup. Unsupported probes keep event-based enforcement; listeners are removed on shutdown. |
| Vault downgrade/corruption, availability stall, or save failure | Linux plaintext safeStorage fallback, interrupted/unsafe replacement, a stuck platform-vault probe, or a failed authority write exposes keys, blocks startup, or leaves wider in-memory access than durable state. | Reused safeStorage policy rejects `basic_text`/`unknown`; separate encrypted vault; hardened replacement/recovery; bounded availability probe. Serialized writes are poisoned on first failure: the process becomes unavailable/disabled, pairing/session authority and timers are cleared, and the relay socket is terminated. Disable/revoke tear down access before saving. Corrupt/decryption failures disable the feature. |

## Privacy consequences

Enabling the feature intentionally makes selected safe conversation text and
remote prompt text available to each approved browser. Anyone controlling that
browser profile, its browser origin, or the unlocked browser session can read
that scope. Device labels, selected projects, grants, audit metadata, delivery
digests, and host keys are stored locally inside the encrypted remote vault.
Prompt bodies are not written to the remote audit log.

The relay necessarily sees network and traffic metadata described above. An
Inertia-hosted service would additionally create processor/subprocessor,
retention, abuse-reporting, lawful-request, residency, deletion, monitoring,
on-call, incident notification, and availability obligations. None are
accepted or implemented by this reference task.

## Resource exhaustion in the utility runtime

The gateway caches sanitized transcript projections so repeated remote polls do
not re-sanitize unchanged provider messages. That cache is a denial-of-service
surface: a paired device only has to navigate between conversations to make the
desktop retain transcript state.

The cache therefore never retains the original provider message. Cache
equality uses a SHA-256 fingerprint of the bounded prefix the sanitizer can
actually inspect (`remoteSanitizerInspectionWindow`, 64 KiB of output budget
plus a 4 KiB secret-scan margin). Because the sanitizer never reads past that
window, the fingerprint is a complete determinant of the projection, and a
multi-megabyte message costs only its sanitized projection plus a 32-byte
digest.

Retention is bounded by bytes rather than by entry count.
`REMOTE_TRANSCRIPT_CACHE_BUDGET_BYTES` is 8 MiB, weighted at two bytes per
retained UTF-16 code unit plus a fixed per-entry overhead, and evicted
least-recently-used first. A single conversation projection may carry at most
`REMOTE_LIMITS.plaintextBytes` (96 KiB) of sanitized text, so the budget holds
roughly eighty saturated projections. The earlier bound was
`transcriptMessages * sessions` entries with no byte ceiling, which allowed
gigabytes of retained provider text.

Cached projections are dropped when a conversation is archived, deleted, or
removed with its project, when Remote Companion is disabled, and when the
encrypted store fails closed. Message edits need no explicit signal because a
changed inspection window changes the fingerprint.

## Deferred capabilities

The MVP deliberately has no remote:

- command, sandbox, Full Access, destructive, or other approval;
- secret question or credential entry;
- terminal;
- file browse/upload/download, attachment, source, path, or diagnostic access;
- provider settings, authentication, maintenance, or route selection;
- Git reversal/mutation;
- permission enablement;
- project/conversation creation;
- remote run stop.

Remote stop remains deferred because the current narrow boundary does not
expose an exact remote-run ownership capability. Adding any item above requires
a new threat model, protocol version, UI decision, and independent review; it
must not be smuggled through prompt text or a generic command.

## Staged delivery and explicit product decisions

Stage 0 is the permanent no-go/default-off state.

Stage 1 is this repository's local/self-hostable reference path: view plus
separately enabled text prompts, explicit device/project grants, local audit,
revocation, lock behavior, reference relay, and independently built browser.

Stage 2, only after review, may package documented private-network deployment
guidance and signed/checksummed browser/relay artifacts. It still must not
create an inbound desktop listener.

Stage 3 would be a separately approved hosted service. Before implementation,
the user/product owner must decide:

- whether Inertia will operate it at all or remain self-host only;
- identity/MFA/account-recovery and organization/device administration;
- regions, retention, deletion, logs, abuse controls, privacy terms, and
  incident response;
- browser artifact signing, pinning, rollback, transparency, and update policy;
- relay SLO/capacity/cost/rate limits and self-host compatibility;
- whether prompt scope is acceptable or view-only should remain the product;
- acceptable grant defaults/maximums and device-loss guidance;
- whether any deferred capability has a defensible exact authority model.

If these decisions and operational capacity are absent, the recommendation is
no production hosted service.

## Security verification plan

Release-blocking deterministic coverage includes:

- HPKE pairing/session success, expiry, replay, comparison mismatch, wrong
  proof/key, ciphertext opacity, malformed/oversized frames, and sequence
  replay;
- Linux plaintext/unknown storage rejection, corrupt vaults, unique
  replacement recovery, Windows replacement, restrictive modes, restart;
- pairing label spoofing, explicit project choice, atomic one-time invitation
  consumption across concurrent routes, invalid-request consumption, invalid
  P-256 rejection before durable mutation, replacement-session teardown after
  durable acceptance, device scope/expiry, reduction/reconnect, revocation,
  stolen-key rejection;
- per-connection/global authentication exhaustion and recovery;
- back-to-back encrypted request/response sequencing with concurrent runtime
  work, atomic duplicate-ID/capacity admission during gated crypto/persistence,
  reservation release on disconnect/revocation, stale route ownership, and
  queue bounds;
- exact process-boundary validation, timeout, worker restart, and shutdown;
- delivery dedupe, fixation, bounded receipt retention, and exact distinction
  between known pre-post failure and posted/no-ack uncertainty;
- prompt-readiness races for access-mode, project/availability, active-run,
  archive, disable, lock, revoke, and grant-reduction changes, proving no queue
  call; archived detail/preparation/commit rejection until unarchive;
  synchronous accepted-post ordering; one-time preparation mismatch/retry,
  expiry, and capacity;
- total device-record cap across restart, deterministic retired-record
  eviction, and no-mutation rejection when all records remain current;
- failed disable, pairing acceptance, and grant-update persistence with
  unavailable/disabled state, no surviving session/reconnect, and unchanged
  durable grants;
- large workspace/transcript UTF-8 byte bounding and maximum-size encrypted
  frame/wrapped-relay delivery;
- relay origin, peer ownership, offline/no-queue, duplicate-endpoint recovery,
  destination-buffer termination, role-aware aggregate/per-browser
  capacity/rate/size behavior;
- browser profile schema/clearing, stale-attempt ownership, single poll-loop
  replacement, synchronous stale-detail clearing/current prompt targeting,
  current-selection archived/not-found clearing and stale-response ownership,
  listener cleanup, pre-parse ASCII/multibyte relay-envelope bounds,
  unsupported/malformed relay data, IPv4/IPv6 loopback policy,
  XSS/provider-output inert rendering, meta-versus-response CSP frame
  protection;
- initially locked startup, lock-during-initialization and lock-during-sample
  retention before connection, power-listener cleanup, arbitrary POSIX,
  drive-letter, UNC, and Windows namespace path redaction with
  URL/punctuation/escaped-prose preservation; backtick/tilde/unterminated/
  indented code and paired/nested/self-closing/interrupted HTML removal with
  adversarial 64 KiB performance bounds and angle-prose preservation;
- real Electron Chromium pairing, authenticated E2EE state exchange, and
  corrupt IndexedDB recovery, including cross-platform static-asset
  containment in the browser fixture.

Before release, run Node 22 `npm run check`, `npm run test:portable`,
production dependency audit, the relevant Electron/browser E2E, platform CI,
and an independent diff/security review. Hosted infrastructure needs separate
penetration, load, disaster-recovery, key-management, browser-supply-chain,
privacy, and operational readiness reviews.
