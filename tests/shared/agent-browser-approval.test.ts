// @inertia-test-suite portable
import { expect, it } from "vitest";
import { parseAgentBrowserApproval, parseAgentBrowserRequest } from "../../src/shared/agent-browser-approval";

it("keeps approval capabilities distinct from bounded provider actions", () => {
  const token = crypto.randomUUID();
  expect(parseAgentBrowserRequest({ action: "prepare-approval", command: { action: "click", ref: "e1" } }))
    .toEqual({ action: "prepare-approval", command: { action: "click", ref: "e1" } });
  expect(parseAgentBrowserRequest({ action: "prepare-approval", command: { action: "perform-approved", token } })).toBeNull();
  expect(parseAgentBrowserRequest({ action: "perform-approved", token, command: { action: "click", ref: "e2" } })).toBeNull();
  expect(parseAgentBrowserRequest({ action: "perform-approved", token: "untrusted" })).toBeNull();
  expect(parseAgentBrowserRequest({ action: "perform-approved", token })).toEqual({ action: "perform-approved", token });
  expect(parseAgentBrowserApproval(JSON.stringify({ token, detail: "Click Submit" }))).toEqual({ token, detail: "Click Submit" });
  expect(parseAgentBrowserApproval(JSON.stringify({ token, detail: "x".repeat(6_001) }))).toBeNull();
  expect(parseAgentBrowserApproval(JSON.stringify({ token, detail: "Click", extra: true }))).toBeNull();
});
