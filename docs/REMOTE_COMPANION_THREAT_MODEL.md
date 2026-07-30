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
| Pairing phishing or invitation theft | Attacker submits a device key using a copied five-minute invitation. | Random PSK, short expiry, attempt limits, authenticated response, six-digit code derived from both keys and invitation, local comparison, sanitized device label, explicit project choice. Six digits require human verification and are not sole authentication. |
| Control/bidi device-label spoofing | Approval list could visually impersonate another browser or reorder text. | Main-process NFKC normalization removes controls and bidi override/isolate marks before pending state or persistence. |
| Pairing replay | Reuse an invitation/request. | One live invitation, five-minute expiry, bounded request-ID replay set, strict request/invitation correlation, local approval. |
| Session replay/fixation | Reuse a valid opening, force sequence reuse, or pin an old grant. | Fresh UUID/timestamp, persisted used-session IDs, HPKE authenticated context bound to host/device/session, exact sequence, desktop current grant returned encrypted. |
| Authentication CPU exhaustion | Repeated invalid openings trigger P-256 work across device keys. | Four attempts per relay connection, 24/minute global budget before crypto, at most 16 device keys, relay connection/message limits. Distributed relay/network DoS remains possible. |
| Malicious project/provider output | XSS, deceptive links, secret/path exfiltration, oversized responses. | Safe projection only, arbitrary POSIX/Windows absolute-path and file-URL redaction, credential/code/HTML redaction, user/assistant roles only, UTF-8 byte budget, strict schemas/CSP, DOM `textContent`, no Markdown/HTML execution. Ordinary HTTP(S) URLs and surrounding punctuation remain usable. Heuristic redaction cannot prove arbitrary prose contains no secret. |
| Remote approval abuse | Prompt induces a Full Access, command, destructive, credential, or secret approval remotely. | Remote protocol has no approval/answer capability. Runtime keeps supervised mode and existing provider approval policy; browser only reports that local action is needed. |
| Prompt/attachment/source leakage | Relay/browser receives sensitive local input, source, attachments, path, or execution payload. | Only explicit remote prompt text and safe projections cross the boundary. No attachment/path/source/diagnostic fields exist in strict schemas. Provider credentials and local capabilities never enter them. |
| Metadata leakage | Relay learns endpoint/IP/timing/size and opaque frame identifiers. | Minimal routing fields, no clear device ID on session opening, no payload logs/queue. Padding, anonymity, and traffic-shape hiding are not provided. |
| Browser profile corruption | Malformed IndexedDB changes relay URL, key, or grant. | Strict schema before use, WSS/loopback-WS transport policy, invalid profile deletion and explicit error. |
| Browser attempt/poll race | Stale pair/reconnect overwrites a newer socket/session, leaves listeners alive, or selection creates duplicate polling loops beyond the request budget. | Monotonic attempt and poll-generation ownership, one replaceable poll timer, tracked opening sockets, stale tunnel close, ownership checks after awaits, complete timer/listener cleanup on close/error/timeout. |
| Relay peer-disconnect spoofing | Third connection closes another browser/desktop pair. | Relay verifies the caller owns the connection before disconnecting it. |
| Relay route lifecycle race | Disconnect or connection-ID reuse lands during asynchronous pairing/session crypto and later commits approval/session state for a dead route. | `peer-connected` creates a desktop-local epoch; disconnect invalidates it synchronously and cleanup is ordered with the per-route frame queue. Post-crypto/persistence commits recheck epoch ownership. Active routes and queued frames are bounded. |
| Concurrent encrypted frames | Parallel `session.data` opens race HPKE recipient sequence and falsely close a valid session as replay; parallel responses race sender sequence. | One bounded inbound queue per route serializes frame opening only; validated runtime requests remain concurrent. A separate per-session outbound queue seals responses in completion order. |
| Denial of service | Oversized/malformed frames, connection churn, queued-frame growth, stalled close, large workspace, reconnect storm. | Layered size/count/rate/time limits, eight active peer-route and 16-frame-per-route caps, byte-bounded projections, no compression, exponential capped reconnect, heartbeat, bounded 1.5-second shutdown then terminate. A relay or network can always make the optional feature unavailable. |
| Stale/offline state | Browser displays old state or duplicates a prompt after uncertainty. | Generated timestamps, two-second live polling only while authenticated, clear offline status, no relay prompt queue, persisted dispatch receipt, no automatic prompt retry. A displayed projection may be up to one poll old. |
| Revocation race | Revoked/reduced device continues with an old session/grant. | Grant change/revoke increments desktop version and closes sessions. Each request checks current device expiry/revocation; reconnect gets current encrypted grant. Revoked keys are not tried. |
| Lock during startup | A persisted enabled profile connects while secure-store/service initialization is awaiting, after a lock/suspend event was missed. | Power listeners are subscribed synchronously at host construction. Locked state is retained, applied before explicit connection startup, and listeners are removed on shutdown. |
| Vault downgrade/corruption or availability stall | Linux plaintext safeStorage fallback, interrupted/unsafe file replacement, or a stuck platform-vault probe exposes keys or blocks startup. | Reused safeStorage availability policy rejects `basic_text`/`unknown`; separate encrypted vault; unique exclusive stages, canonical directory containment, no-follow regular-file reads, bounds/mode, restart recovery, Windows replacement path. Fresh default-off startup does not probe storage or create keys; existing-vault availability is bounded and fails closed. Corrupt/decryption failures disable the feature. |

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
- pairing label spoofing, explicit project choice, device scope/expiry,
  reduction/reconnect, revocation, stolen-key rejection;
- per-connection/global authentication exhaustion and recovery;
- back-to-back encrypted request/response sequencing with concurrent runtime
  work, relay disconnect during gated crypto, stale route ownership, and queue
  bounds;
- exact process-boundary validation, timeout, worker restart, and shutdown;
- delivery dedupe, fixation, uncertain delivery, bounded receipt retention;
- large workspace/transcript UTF-8 byte bounding;
- relay origin, peer ownership, offline/no-queue, capacity/rate/size behavior;
- browser profile schema/clearing, stale-attempt ownership, single poll-loop
  replacement, listener cleanup, IPv4/IPv6 loopback policy,
  XSS/provider-output inert rendering, strict CSP;
- startup lock retention before connection, power-listener cleanup, arbitrary
  POSIX path redaction with URL/punctuation preservation;
- real Electron Chromium pairing, authenticated E2EE state exchange, and
  corrupt IndexedDB recovery.

Before release, run Node 22 `npm run check`, `npm run test:portable`,
production dependency audit, the relevant Electron/browser E2E, platform CI,
and an independent diff/security review. Hosted infrastructure needs separate
penetration, load, disaster-recovery, key-management, browser-supply-chain,
privacy, and operational readiness reviews.
