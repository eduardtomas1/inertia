export const MESSAGE_SEND_PREPARATION_TIMEOUT_MS = 120_000;

// The renderer must remain pending through the authoritative server deadline
// plus bounded checkpoint and attachment cleanup after a rejected send.
export const MESSAGE_SEND_REQUEST_TIMEOUT_MS =
  MESSAGE_SEND_PREPARATION_TIMEOUT_MS + 60_000;

export const CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS = 60_000;

export const PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS = 10 * 60_000;
export const CONVERSATION_COMPACTION_REQUEST_TIMEOUT_MS =
  PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS + 60_000;

// A single read can invoke several individually bounded Git subprocesses.
// Give the server one aggregate deadline, then leave transport/cleanup
// headroom so its authoritative response reaches the renderer first.
export const GIT_READ_OPERATION_TIMEOUT_MS = 120_000;
// Pre-turn artifacts are auxiliary to provider delivery. A single slow Git
// inspection must fail the artifact closed without holding the user request
// behind a chain of independently bounded subprocesses.
export const TURN_GIT_ARTIFACT_PRE_CAPTURE_TIMEOUT_MS = 10_000;
export const TURN_GIT_ARTIFACT_FINALIZATION_TIMEOUT_MS = 60_000;
export const GIT_READ_REQUEST_TIMEOUT_MS =
  GIT_READ_OPERATION_TIMEOUT_MS + 60_000;

// Mutations can legitimately combine a network operation with several local
// validation and post-operation status subprocesses. Delivery remains
// ambiguous if this outer client deadline is ever reached.
export const GIT_MUTATION_REQUEST_TIMEOUT_MS = 10 * 60_000;

// Duo dispatch captures both pre-turn Git states in parallel. Each side's
// longest path combines an isolated checkpoint's individually bounded Git
// steps with bounded repository fingerprinting, so it shares the conservative
// mutation envelope instead of the 15-second ordinary-command deadline.
export const DUO_DISPATCH_REQUEST_TIMEOUT_MS =
  GIT_MUTATION_REQUEST_TIMEOUT_MS;

// Cancellation may join the same bounded preparation task (including owned
// worktree compensation) before returning its authoritative terminal state.
export const DUO_CANCEL_REQUEST_TIMEOUT_MS =
  GIT_MUTATION_REQUEST_TIMEOUT_MS;

// Workspace file reads may cross the privileged secure-file broker, whose
// operations are bounded at 30 seconds. Leave enough room for the runtime to
// return its authoritative result without reconnecting the shared socket.
export const WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS = 45_000;
export const WORKSPACE_FILE_REQUEST_TIMEOUT_MS = 90_000;
export const WORKSPACE_FILE_MUTATION_REQUEST_TIMEOUT_MS = 180_000;

// Native goal and skill reads combine bounded provider discovery with a
// one-shot provider control request.
export const AGENT_WORKFLOW_REQUEST_TIMEOUT_MS = 45_000;

export const REVIEW_OPERATION_REQUEST_TIMEOUT_MS = 10 * 60_000;

// Backend probes can use their full 30-second safety deadline. A timed-out
// probe is still delivery-ambiguous because it persists compatibility state.
export const BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS = 45_000;

// Workspace discovery can inspect thousands of folders and many independent
// repositories. Keep the renderer pending through that bounded operation
// instead of turning an expected scan into a transport reconciliation loop.
export const WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS = 90_000;
export const WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS =
  WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS + 60_000;
export const GIT_REFRESH_REQUEST_TIMEOUT_MS = GIT_READ_REQUEST_TIMEOUT_MS;

// Provider discovery combines bounded executable, authentication, metadata,
// and latest-version probes. Its client deadline must exceed those server-side
// bounds while still settling a genuinely stalled request.
export const PROVIDER_REFRESH_REQUEST_TIMEOUT_MS = 45_000;
export const PROVIDER_MAINTENANCE_REFRESH_REQUEST_TIMEOUT_MS = 30_000;
