# Claude metadata cleanup regression (#354)

The existing macOS ARM64 startup scenario could stop the local runtime before New
chat persisted a conversation. It reproduced on exact v0.0.54 (`3121f209`) and
frozen v0.0.55 (`eed32810`) with their respective locked dependencies, so this is a
pre-existing defect. The release coordinator held v0.0.55 for correction.

The first visible failure followed opening/closing Terminal, but the implicated
owner was the background Claude SDK metadata child, not the Terminal PTY. The
profile/project and Codex provider behavior were synthetic; background discovery
also found locally installed Claude. No prompt was submitted during this case.

Fixed-vocabulary diagnostic instrumentation established:

- Models and rate limits both fulfilled, without parent cancellation, SDK abort
  or transport error.
- The first forced termination came from `readClaudeAgentSdkMetadata`'s `finally`.
- The unchanged native guardian observed `NOTE_FORK`, then cleanup ran with
  `payload_settled=0`, `stop_requested=1`, `graceful_exit_requested=0`; its final
  parent identity check was false by drain time. It emitted `drain-fork-taint`.
- The runtime correctly retained its safety lock for unconfirmed process cleanup.

Successful metadata now closes the SDK query through stdin EOF and waits at most
2 seconds for ordinary child close and exact ownership retirement, matching the
pinned SDK's normal-close window. The existing owned termination barrier remains
mandatory afterward. Cancellation, timeout, transport errors, unavailable normal
close and unconfirmed ownership retain the existing hard-stop behavior. No native
guardian policy, signal authority or process identity check was weakened.

`tests/server/claude-metadata-natural-close.test.ts` uses the pinned SDK and real
native guardian with a synthetic provider. The provider forks and observes its
helper complete, returns metadata, then records EOF before exiting. The original
implementation fails with `ProcessTreeTerminationError`; the correction passes
with exit 0, no taint and confirmed ownership. Timeout and cancellation after the
same fork still retain SIGUSR2 taint and reject unconfirmed cleanup. This fixture
requires no installed provider, account, user configuration or network service.

The unchanged native startup scenario passed after correction (7.4 seconds) on the
same local checkout/environment. Focused metadata, transport and native guardian
checks passed 67 tests. Original/fixed native traces, cleanup receipts, version
records and diagnostic-only copies are retained in the independent audit artifact.
Diagnostic instrumentation is absent from production source and the verified
fixed build. All test launchers were closed by their own bounded fixture cleanup;
no recovery attestation was accepted and no unrelated process was signalled.
