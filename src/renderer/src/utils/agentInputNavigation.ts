export function revealAgentInputRequest(requestId: string): boolean {
  const request = document.getElementById(`agent-input-request-${requestId}`);
  if (!request) return false;
  request.scrollIntoView({ block: "nearest", behavior: "smooth" });
  request.querySelector<HTMLElement>(
    "input, button, select, textarea",
  )?.focus();
  return true;
}
