export const AGENT_SECRET_VALUE_ISSUES = Object.freeze({
  notText: "Paste the secret as text.",
  tooLong: "The secret is longer than 16,384 characters.",
  blank: "Paste the secret. Only spaces or line breaks were entered.",
  masked: "Paste the secret itself. The masked placeholder cannot be saved.",
  multiline: "The secret must be on a single line.",
  tooShort: "The secret must be at least 4 characters long.",
});

export const AGENT_SECRET_SAVE_ERRORS = Object.freeze({
  notPending: "That secret request is no longer pending.",
  fileFailed: "Inertia couldn't write the private file. Try again.",
  limit: "Too many agent secrets are active. Revoke one in Settings, then try again.",
  runtimeUnavailable: "The local runtime is not available. Try again in a moment.",
  storageStarting: "Secure storage is still starting. Try again in a moment.",
  invalid: "The secret request is invalid.",
  foreignConversation: "Detached chats can answer secret requests only for their owned conversation.",
});
