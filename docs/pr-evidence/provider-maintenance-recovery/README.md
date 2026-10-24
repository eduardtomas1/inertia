# Provider maintenance startup recovery

An interrupted provider update previously disabled discovery and credential
initialization for every provider while leaving their visible state at
"Checking". Recovery could also consume the original runtime's cleanup receipt
before preserving the proof needed by a retained maintenance record.

## Result

- Only providers with unresolved startup maintenance are blocked. Other providers
  still discover, connect, and run through their ordinary installation checks.
- Settings shows **Recovery required**, explains restart/support, and pauses the
  executable check instead of claiming the executable is missing.
- Backend credential status remains readable. Profiles belonging to a blocked
  harness are not mutated or republished during initialization.
- Prior-runtime maintenance remains quarantined and durable while the current
  runtime can close cleanly. New unfinished maintenance still fails shutdown.
- Limits retains recovery guidance and clears cached quota windows for blocked
  providers. Usage entry points refuse recovery before resolving commands or
  reading provider credentials.

## Cleanup proof

Startup writes an integrity-checked `cleaned` journal phase using only exact
generation cleanup authority or confirmed prior-boot cleanup, before acknowledging
the supervisor's receipt. Failed conformance can then retry after another restart
without losing that proof. Every retry still verifies the native installation
before durably retiring maintenance ownership.

Retirement removes `verified`, then `owning`, then `cleaned`. An interrupted final
unlink leaves a usable cleanup checkpoint, including when `owning` was already
removed. Publication failure prevents receipt acknowledgement and closes the
persistent stores. Missing processes or missing leases never create cleanup proof.

Prior-boot proof requires two known, valid boot identities. An unavailable boot
identity requires exact generation cleanup authority. Installation recovery can
complete while signed out; normal account readiness still controls execution.
Custom backend errors retain the provider's recovery guidance.

Existing `owning`/`verified` journals remain readable; there is no database
migration. An older build will fail closed if a new `cleaned` checkpoint remains.

## Verification

Regression coverage includes exact/mismatched generation proof, prior-boot proof,
interrupted checkpoint publication and retirement, retry after receipt consumption,
disabled execution, provider launch guards, native recovery/retirement, unrelated
provider readiness, credential reads without mutation, clean shutdown, and Settings.

Runtime integration covers every provider in the registry: Codex, Claude, Cursor,
Kimi, OpenCode, and Antigravity. Each provider is tested both as the blocked
installation and with unrelated providers available. Coverage also includes
simultaneous recoveries with different outcomes, signed-out recovery, Kimi's
session-time authentication, and Antigravity's deferred sign-in check. Native
discovery fixtures remain separate from the injected runtime integration tests.

The local browser fixture rendered the real `ProvidersSettings` component with
synthetic before/after snapshots. At 1280 x 800, the semantic snapshots showed
Claude changing from Checking to Recovery required while Codex became Connected;
switching providers preserved Codex's Refresh and Browse controls. Each semantic
audit had zero errors/warnings. Screenshots were recorded in the local Evidence
timeline; they were not pixel-reviewed by the agent. No installed user profile or
live provider credentials were used for this fixture.

The original maintenance command's failure is still unknown. This change prevents
the observed startup blockage and loss of cleanup proof; it does not manufacture
proof for an already orphaned same-boot record.
