import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IssueReportSettings } from "../../src/renderer/src/components/IssueReportSettings";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ModelBackendProfileView, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import type { IssueReport } from "../../src/shared/issue-report";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
const selection = modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "claude", modelId: "claude-test", reasoningEffort: "high" }));
const provider = { id: "claude", label: "Claude", command: "claude", available: true, version: "1.0.0", canRun: true, installState: "installed", authState: "authenticated", statusMessage: null, models: [{ id: "claude-test", label: "Claude Test", isDefault: true, reasoningOptions: [{ value: "high", label: "High" }], defaultReasoningEffort: "high", inputModalities: ["text"], description: "" }], metadataState: { models: { freshness: "fresh" } } } as ProviderInfo;
function fixture(initial: IssueReport | null = null) {
  let report = initial;
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "support.report.prepare") report = { id: "11111111-1111-4111-8111-111111111111", revision: 0, status: "draft", ...command.payload, title: "Chat cancellation issue", body: "## Problem\nThe chat fails after cancellation.\n## Safe evidence\nPlatform: linux", evidence: '{"platform":"linux","lifecycle":"safe-and-ready"}', answer: "", notice: "Private draft saved.", issueUrl: null };
    if (command.type === "support.report.edit" && report) report = { ...report, ...command.payload, status: "preview", revision: report.revision + 1 };
    if (command.type === "support.report.retire" && report) report = { ...report, status: "retired", revision: report.revision + 1, notice: "Publication tracking retired. The original issue may already exist on GitHub." };
    if (command.type === "support.report.submit" && report) report = { ...report, status: "submitted", revision: report.revision + 1, issueUrl: "https://github.com/eduardtomas1/inertia/issues/999", notice: "Issue published." };
    return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "support.report", report } };
  });
  const props = { providers: [provider], projects: [], backendProfiles: [], disabled: false, request, onProviderSetup: vi.fn() };
  return { request, props, saved: () => report };
}
afterEach(cleanup);
it("guides model/reasoning selection into a saved private chat, edits the preview, and submits only explicitly", async () => {
  const { props, request, saved } = fixture();
  const view = render(<IssueReportSettings {...props} />);
  await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "support.report.get" }));
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "The chat fails after I cancel a running turn." } });
  fireEvent.change(screen.getByLabelText("Report agent and model"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Report reasoning"), { target: { value: "high" } });
  fireEvent.click(screen.getByRole("button", { name: "Create private report chat" }));
  await screen.findByLabelText("Private report chat");
  expect(saved()?.selection).toMatchObject({ modelId: "claude-test", reasoningEffort: "high" });
  expect(request.mock.calls.some(([command]) => command.type === "support.report.submit")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Edit issue preview" }));
  fireEvent.change(screen.getByLabelText("Issue title"), { target: { value: "Cancellation leaves a chat unable to start" } });
  expect(screen.getByRole("button", { name: "Confirm preview" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save and review preview" }));
  await screen.findByRole("button", { name: "Submit issue to GitHub" });
  expect(request.mock.calls.some(([command]) => command.type === "support.report.submit")).toBe(false);
  view.unmount();
  render(<IssueReportSettings {...props} />);
  await screen.findByText("Cancellation leaves a chat unable to start");
  fireEvent.click(screen.getByRole("button", { name: "Submit issue to GitHub" }));
  await screen.findByRole("button", { name: "View published issue" });
  expect(request.mock.calls.filter(([command]) => command.type === "support.report.submit")).toHaveLength(1);
});
it("offers setup and a useful manual preview without available provider authentication", async () => {
  const { props } = fixture();
  render(<IssueReportSettings {...props} providers={[]} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Open provider setup" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Open provider setup" }));
  await waitFor(() => expect(props.onProviderSetup).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "A report without provider authentication should still work." } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Create private report chat" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Create private report chat" }));
  await screen.findByLabelText("Private report chat");
  expect(screen.getByRole("button", { name: "Validate with selected model" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Confirm preview" })).toBeEnabled();
});
it("shows failure and retry while preserving description and preview", async () => {
  const { props, request } = fixture({ id: crypto.randomUUID(), revision: 2, status: "failed", selection, projectId: null, description: "Cancel a running chat then send again.", title: "Cancellation issue", body: "Problem and safe evidence remain available.", evidence: "{}", answer: "", notice: "Validation reached its deadline. Retry or continue manually.", issueUrl: null });
  render(<IssueReportSettings {...props} />);
  await screen.findByText(/Validation reached its deadline/u);
  expect(screen.getByRole("button", { name: "Retry validation" })).toBeEnabled();
  expect(screen.getByText("Problem and safe evidence remain available.")).toBeVisible();
  expect(request.mock.calls).toHaveLength(1);
});


it("saves a filled report before leaving for provider authentication setup", async () => {
  const { props, saved } = fixture();
  render(<IssueReportSettings {...props} providers={[]} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Open provider setup" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "Keep these reproduction details while I connect my provider." } });
  fireEvent.click(screen.getByRole("button", { name: "Open provider setup" }));
  await waitFor(() => expect(props.onProviderSetup).toHaveBeenCalledOnce());
  expect(saved()?.description).toContain("Keep these reproduction details");
});

const externalProfile: ModelBackendProfileView = {
  id: "custom:report", displayName: "Report backend", harnessId: "claude-agent-sdk", protocol: "anthropic-messages", authenticationMode: "api-key", source: "custom", enabled: true,
  configurationRevision: 4, endpointIdentity: "report-endpoint", preset: "custom", allowInsecureLocalhost: false, credentialGeneration: "generation:1",
  models: [{ id: "team-model", displayName: "Team model", contextWindowTokens: null, reasoningOptions: [], capabilities: [] }],
  routing: { mode: "simple", primaryModelId: "team-model" }, capabilityHints: [], createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z", endpointHost: "example.test",
  authState: "configured", connectionState: "connected", compatibility: { harnessId: "claude-agent-sdk", backendProfileId: "custom:report", backendProtocol: "anthropic-messages", state: "partially-compatible", provenance: "probe", allowsModelSwitchWithinSession: false, reasonCode: "anthropic-probe-verified", reason: "Verified route." }, latestProbe: null, canDelete: true, canDisable: true,
};
function savedReport(status: IssueReport["status"]): IssueReport {
  return { id: crypto.randomUUID(), revision: 3, status, selection, projectId: null, description: "An uncertain issue about cancellation.", title: "Cancellation issue", body: "The original issue may already have been published.", evidence: "{}", answer: "", notice: "Check GitHub before proceeding.", issueUrl: null };
}
it("requires reviewed retirement, preserves the preview, and starts an unrelated draft blank", async () => {
  const initial = savedReport("uncertain");
  const { props, request, saved } = fixture(initial);
  render(<IssueReportSettings {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retire this report" }));
  expect(screen.getByRole("group", { name: "Retire uncertain publication?" })).toHaveTextContent("may already exist on GitHub");
  expect(screen.getByRole("group", { name: "Retire uncertain publication?" })).toHaveFocus();
  expect(request.mock.calls.some(([command]) => command.type === "support.report.retire")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Keep checking" }));
  expect(screen.queryByRole("button", { name: "Confirm retirement" })).toBeNull();
  expect(screen.getByRole("button", { name: "Retire this report" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Retire this report" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm retirement" }));
  await screen.findByText(/Publication tracking retired/u);
  expect(request).toHaveBeenCalledWith({ type: "support.report.retire", payload: { id: initial.id, revision: 3, acknowledgeUncertainPublication: true } });
  expect(saved()).toMatchObject({ status: "retired", body: initial.body });
  expect(screen.getByRole("button", { name: "Copy preview" })).toBeEnabled();
  for (const name of ["Check submission", "Validate with selected model", "Edit issue preview", "Confirm preview", "Submit issue to GitHub"]) expect(screen.queryByRole("button", { name })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start another draft" }));
  expect(screen.getByLabelText("What happened?")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Create private report chat" })).toBeDisabled();
  expect(saved()?.status).toBe("retired");
});
it.each(["configured", "missing"] as const)("uses external backend credential readiness (%s), independent of native Claude login", async (authState) => {
  const initial = { ...savedReport("draft"), selection: { ...selection, backendProfileId: externalProfile.id, backendProfileDisplayName: externalProfile.displayName, backendConfigurationRevision: 4, modelId: "team-model" } };
  const { props } = fixture(initial);
  render(<IssueReportSettings {...props} backendProfiles={[{ ...externalProfile, authState }]} providers={[{ ...provider, executable: "/synthetic/claude", canRun: false, authState: "unauthenticated" }]} />);
  const validate = await screen.findByRole("button", { name: "Validate with selected model" });
  if (authState === "configured") expect(validate).toBeEnabled(); else expect(validate).toBeDisabled();
});

it("clears a hidden editor when reloading a report retired by another client", async () => {
  const initial = savedReport("draft");
  const { props, request } = fixture(initial);
  render(<IssueReportSettings {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit issue preview" }));
  expect(screen.getByRole("button", { name: "Copy preview" })).toBeDisabled();
  request.mockResolvedValueOnce({ type: "request.result", requestId: crypto.randomUUID(), result: { kind: "support.report", report: { ...initial, revision: 8, status: "retired" } } });
  fireEvent.click(screen.getByRole("button", { name: "Reload saved progress" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy preview" })).toBeEnabled());
  expect(screen.queryByLabelText("Issue body")).toBeNull();
});

it.each([true, false])("copies report previews through the privileged bridge (success=%s)", async (copied) => {
  const previous = Object.getOwnPropertyDescriptor(window, "inertia");
  const copyText = vi.fn(async () => copied);
  Object.defineProperty(window, "inertia", { configurable: true, value: { copyText } });
  try {
    const initial = savedReport("preview");
    const { props } = fixture(initial);
    render(<IssueReportSettings {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy preview" }));
    await screen.findByText(copied ? "Preview copied." : "Could not copy. Select the preview text manually.");
    expect(copyText).toHaveBeenCalledWith(`${initial.title}\n\n${initial.body}`);
  } finally {
    if (previous) Object.defineProperty(window, "inertia", previous);
    else Reflect.deleteProperty(window, "inertia");
  }
});
