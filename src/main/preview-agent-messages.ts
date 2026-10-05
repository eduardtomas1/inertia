import type { AgentPageWithheldReason } from "./preview-agent-page.js";

export function withheldEvidenceMessage(reason: AgentPageWithheldReason, subject: string): string {
  const recovery = " Navigate to the page again to load a new document, then continue.";
  if (reason === "password") {
    return `${subject} withheld because this document holds a password or another sensitive value, which Inertia never sends to a model.${recovery}`;
  }
  if (reason === "redaction-limit") {
    return `${subject} withheld because this document exceeds the limit for safely hiding sensitive values.${recovery}`;
  }
  if (reason === "hidden-input") {
    return `${subject} withheld because text was typed into a control Inertia cannot inspect (inside a closed shadow root), so it could be a password.${recovery}`;
  }
  if (reason === "document-too-large") {
    return `${subject} withheld because this page has more than 4,000 inputs and text areas, too many for Inertia to check safely for sensitive values. Open a smaller page or a more specific route that shows fewer inputs, then continue.`;
  }
  return `${subject} withheld because a script changed a sensitive field in this document.${recovery}`;
}

export function navigationFailureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  const code = /\bERR_[A-Z_]+/u.exec(text)?.[0] ?? "";
  if (code === "ERR_CONNECTION_REFUSED") {
    return "Nothing answered at that address (connection refused). Start the development server or check its port, then navigate again.";
  }
  if (code === "ERR_UNSAFE_PORT") {
    return "Chromium refuses to open that port. Run the development server on a different port, then navigate to it.";
  }
  if (code === "ERR_NAME_NOT_RESOLVED") {
    return "That host name could not be resolved. Use localhost, 127.0.0.1 or [::1] with the development server's port.";
  }
  if (["ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_EMPTY_RESPONSE"].includes(code)) {
    return "The server closed the connection before sending a page. Check the development server's output, then navigate again.";
  }
  if (["ERR_CONNECTION_TIMED_OUT", "ERR_TIMED_OUT"].includes(code)) {
    return "The server did not answer in time. Check that the development server is running, then navigate again.";
  }
  if (code.startsWith("ERR_CERT_") || code === "ERR_SSL_PROTOCOL_ERROR") {
    return "The page's HTTPS certificate is not trusted by Inertia Browser. Use the development server's http:// address if it has one.";
  }
  if (code === "ERR_BLOCKED_BY_CLIENT" || code === "ERR_BLOCKED_BY_RESPONSE") {
    return "The page was blocked, usually because it redirected to an address outside this machine. Inertia Browser only opens local development pages.";
  }
  return `The page could not be loaded${code ? ` (${code})` : ""}. Check that the development server is running, then navigate again.`;
}
