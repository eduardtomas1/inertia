import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IssueReportSettings } from "../../src/renderer/src/components/IssueReportSettings";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import type { ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import type { IssueReport } from "../../src/shared/issue-report";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
const selection = modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "claude", modelId: "claude-test", reasoningEffort: "high" }));
const provider = { id: "claude", label: "Claude", command: "claude", available: true, version: "1.0.0", canRun: true, installState: "installed", authState: "authenticated", statusMessage: null, models: [{ id: "claude-test", label: "Claude Test", isDefault: true, reasoningOptions: [{ value: "high", label: "High" }], defaultReasoningEffort: "high", inputModalities: ["text"], description: "" }], metadataState: { models: { freshness: "fresh" } } } as ProviderInfo;
function fixture(initial: IssueReport | null = null) {
  let report = initial;
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "support.report.prepare") report = { id: "11111111-1111-4111-8111-111111111111", revision: 0, status: "draft", ...command.payload, title: "Chat cancellation issue", body: "## Problem\nThe chat fails after cancellation.\n## Safe evidence\nPlatform: linux", evidence: '{"platform":"linux","lifecycle":"safe-and-ready"}', answer: "", notice: "Private draft saved.", issueUrl: null };
    if (command.type === "support.report.edit" && report) report = { ...report, ...command.payload, status: "preview", revision: report.revision + 1 };
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
  fireEvent.click(screen.getByRole("button", { name: "Open provider setup" }));
  expect(props.onProviderSetup).toHaveBeenCalledOnce();
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
