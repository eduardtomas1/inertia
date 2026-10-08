export function revealAgentInputRequest(requestId: string): boolean {
  const request = document.getElementById(`agent-input-request-${requestId}`);
  if (!request) return false;
  request.scrollIntoView({ block: "nearest", behavior: "smooth" });
  (request.querySelector<HTMLElement>("input, select, textarea")
    ?? request.querySelector<HTMLElement>("button"))?.focus();
  return true;
}
