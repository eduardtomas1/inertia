export const MESSAGE_SEND_PREPARATION_TIMEOUT_MS = 120_000;

// The renderer must remain pending through the authoritative server deadline
// plus bounded checkpoint and attachment cleanup after a rejected send.
export const MESSAGE_SEND_REQUEST_TIMEOUT_MS =
  MESSAGE_SEND_PREPARATION_TIMEOUT_MS + 60_000;

export const CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS = 60_000;
