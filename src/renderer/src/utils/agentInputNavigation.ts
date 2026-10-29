import { secretRequestElementId } from "./response-timeline/secretRequests";

export function revealAgentInputRequest(requestId: string): boolean {
  const request = document.getElementById(`agent-input-request-${requestId}`);
  if (!request) return false;
  request.scrollIntoView({ block: "nearest", behavior: "smooth" });
  request.querySelector<HTMLElement>(
    "input, button, select, textarea",
  )?.focus();
  return true;
}

export function revealSecretRequest(requestId: string): boolean {
  const card = document.getElementById(secretRequestElementId(requestId));
  if (!card) return false;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.querySelector<HTMLElement>("input, button")?.focus();
  return true;
}
