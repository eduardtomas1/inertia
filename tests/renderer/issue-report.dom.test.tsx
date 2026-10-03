import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IssueReportSettings } from "../../src/renderer/src/components/IssueReportSettings";
import type { ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import type { IssueGitHubState, IssueReport } from "../../src/shared/issue-report";
import { ISSUE_GITHUB_MESSAGES } from "../../src/shared/issue-report-github";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

const providers = [{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }] as ProviderInfo[];
const id = "11111111-1111-4111-8111-111111111111";
const bridge = { copyText: vi.fn(async (_text: string) => true), openExternal: vi.fn(async (_url: string) => undefined) };
let previous: PropertyDescriptor | undefined;
beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(window, "inertia");
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
});
afterEach(() => {
  cleanup();
  bridge.copyText.mockClear();
  bridge.openExternal.mockClear();
  if (previous) Object.defineProperty(window, "inertia", previous);
  else Reflect.deleteProperty(window, "inertia");
});

function saved(status: IssueReport["status"], overrides: Partial<IssueReport> = {}): IssueReport {
  return { id, revision: 3, status, description: "The chat fails after I cancel a running turn.", steps: "", providerId: null, attachDiagnostics: true, title: "Cancellation issue", body: "## What happened\n\nThe chat fails after I cancel a running turn.", notice: "", issueUrl: null, ...overrides };
}

function fixture(initial: IssueReport | null = null, github: IssueGitHubState = "ready") {
  let report = initial;
  const respond = (extra: { github?: IssueGitHubState } = {}): ServerEvent => ({ type: "request.result", requestId: crypto.randomUUID(), result: { kind: "support.report", report, ...extra } });
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "support.report.github") return respond({ github });
    if (command.type === "support.report.prepare") report = { ...saved("preview"), revision: 0, ...command.payload, title: command.payload.description.split("\n")[0]!, body: `## What happened\n\n${command.payload.description}` };
    if (command.type === "support.report.edit" && report) report = { ...report, title: command.payload.title.trim(), body: command.payload.body.trim(), status: "preview", revision: report.revision + 1 };
    if (command.type === "support.report.submit" && report) report = { ...report, status: "submitted", revision: report.revision + 1, issueUrl: "https://github.com/eduardtomas1/inertia/issues/999", notice: "Issue created in eduardtomas1/inertia." };
    if (command.type === "support.report.retire" && report) report = { ...report, status: "retired", revision: report.revision + 1, notice: "Publication tracking retired. The original issue may already exist on GitHub." };
    return respond();
  });
  return { request, props: { providers, disabled: false, request }, current: () => report, setReport: (next: IssueReport) => { report = next; } };
}

const commands = (request: ReturnType<typeof fixture>["request"], type: string) => request.mock.calls.map(([command]) => command).filter((command) => command.type === type);

it("previews the code-generated issue from a plain form and publishes only on request", async () => {
  const { props, request } = fixture();
  render(<IssueReportSettings {...props} />);
  await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "support.report.github" }));
  expect(screen.getByRole("button", { name: "Preview issue" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "The chat fails after I cancel a running turn." } });
  fireEvent.change(screen.getByLabelText("Steps to reproduce (optional)"), { target: { value: "Start, cancel, send again" } });
  fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
  expect(screen.getByLabelText("Provider")).toHaveDisplayValue("Codex");
  expect(screen.getByRole("checkbox", { name: /Attach diagnostics/u })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Preview issue" }));
  await waitFor(() => expect(screen.getByLabelText("Title")).toHaveFocus());
  expect(commands(request, "support.report.prepare")).toEqual([{ type: "support.report.prepare", payload: { description: "The chat fails after I cancel a running turn.", steps: "Start, cancel, send again", providerId: "codex", attachDiagnostics: true } }]);
  expect(screen.getByLabelText("Body")).toHaveValue("## What happened\n\nThe chat fails after I cancel a running turn.");
  expect(commands(request, "support.report.submit")).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "My own wording of the problem, edited by hand." } });
  fireEvent.click(screen.getByRole("button", { name: "Create on GitHub" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "View issue" })).toHaveFocus());
  expect(commands(request, "support.report.edit")).toEqual([{ type: "support.report.edit", payload: { id, revision: 0, title: "The chat fails after I cancel a running turn.", body: "My own wording of the problem, edited by hand." } }]);
  expect(commands(request, "support.report.submit")).toEqual([{ type: "support.report.submit", payload: { id, revision: 1 } }]);
  fireEvent.click(screen.getByRole("button", { name: "View issue" }));
  expect(bridge.openExternal).toHaveBeenCalledWith("https://github.com/eduardtomas1/inertia/issues/999");
});

it("shows the GitHub CLI problem before the user writes anything", async () => {
  const { props } = fixture(null, "signed-out");
  render(<IssueReportSettings {...props} />);
  expect(await screen.findByText(ISSUE_GITHUB_MESSAGES["signed-out"])).toBeVisible();
  expect(screen.getByLabelText("What happened")).toBeEnabled();
});

it("keeps hand edits when going back and returning without regenerating the issue", async () => {
  const { props, request } = fixture(saved("preview"));
  render(<IssueReportSettings {...props} />);
  fireEvent.change(await screen.findByLabelText("Body"), { target: { value: "Edited body that must survive going back." } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(screen.getByLabelText("What happened")).toHaveFocus());
  expect(commands(request, "support.report.edit")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Preview issue" }));
  expect(await screen.findByLabelText("Body")).toHaveValue("Edited body that must survive going back.");
  expect(commands(request, "support.report.prepare")).toHaveLength(0);
});

it("does not overwrite an edit when a slower refresh of the same report arrives", async () => {
  const { props, request } = fixture(saved("preview"));
  let release!: () => void;
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (command) => {
    if (command.type === "support.report.github") await new Promise<void>((resolve) => { release = resolve; });
    return await original(command);
  });
  render(<IssueReportSettings {...props} />);
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Typed before the check finished" } });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  release();
  await waitFor(() => expect(commands(request, "support.report.github")).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByLabelText("Title")).toHaveValue("Typed before the check finished");
});

it("announces a publication failure with its own message and keeps the issue retryable", async () => {
  const { props, request } = fixture(saved("preview"));
  const original = request.getMockImplementation()!;
  request.mockImplementationOnce(original).mockImplementationOnce(original).mockImplementationOnce(async () => ({ type: "request.result", requestId: crypto.randomUUID(), result: { kind: "support.report", report: saved("failed", { revision: 4, notice: ISSUE_GITHUB_MESSAGES["rate-limited"] }) } }));
  render(<IssueReportSettings {...props} />);
  await screen.findByLabelText("Body");
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Create on GitHub" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(ISSUE_GITHUB_MESSAGES["rate-limited"]);
  expect(screen.getByRole("button", { name: "Create on GitHub" })).toBeEnabled();
  expect(screen.getByLabelText("Body")).toHaveValue(saved("failed").body);
});

it("shows a saved failure on reopening without an alert", async () => {
  const { props } = fixture(saved("failed", { notice: ISSUE_GITHUB_MESSAGES.offline }));
  render(<IssueReportSettings {...props} />);
  expect(await screen.findByText(ISSUE_GITHUB_MESSAGES.offline)).toHaveAttribute("role", "status");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("opens GitHub prefilled, or copies the issue when it is too long for a link", async () => {
  const { props } = fixture(saved("preview"));
  render(<IssueReportSettings {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open GitHub manually" }));
  await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledOnce());
  const prefilled = new URL(bridge.openExternal.mock.calls[0]![0]);
  expect(prefilled.pathname).toBe("/eduardtomas1/inertia/issues/new");
  expect(prefilled.searchParams.get("title")).toBe("Cancellation issue");
  expect(prefilled.searchParams.get("body")).toBe(saved("preview").body);
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "x".repeat(5_000) } });
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub manually" }));
  await screen.findByText("The issue is too long for a link, so it was copied. Paste it into the body on GitHub.");
  expect(bridge.copyText).toHaveBeenCalledWith(`Cancellation issue\n\n${"x".repeat(5_000)}`);
  const fallback = new URL(bridge.openExternal.mock.calls[1]![0]);
  expect(fallback.searchParams.get("title")).toBe("Cancellation issue");
  expect(fallback.searchParams.has("body")).toBe(false);
});

it.each([true, false])("copies the issue through the privileged bridge (success=%s)", async (copied) => {
  bridge.copyText.mockResolvedValueOnce(copied);
  const { props } = fixture(saved("preview"));
  render(<IssueReportSettings {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
  await screen.findByText(copied ? "Copied." : "Could not copy. Select the text and copy it manually.");
  expect(bridge.copyText).toHaveBeenCalledWith(`Cancellation issue\n\n${saved("preview").body}`);
});

it("requires reviewed retirement, preserves the preview, and starts an unrelated report blank", async () => {
  const { props, request, current } = fixture(saved("uncertain", { notice: "GitHub may have received the issue." }));
  render(<IssueReportSettings {...props} />);
  expect(screen.queryByRole("button", { name: "Create on GitHub" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Retire this report" }));
  await waitFor(() => expect(screen.getByRole("group", { name: "Retire uncertain publication?" })).toHaveFocus());
  expect(screen.getByRole("group", { name: "Retire uncertain publication?" })).toHaveTextContent("may already exist on GitHub");
  expect(commands(request, "support.report.retire")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Keep checking" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retire this report" })).toHaveFocus());
  expect(screen.queryByRole("button", { name: "Confirm retirement" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retire this report" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm retirement" }));
  await screen.findByText(/Publication tracking retired/u);
  expect(commands(request, "support.report.retire")).toEqual([{ type: "support.report.retire", payload: { id, revision: 3, acknowledgeUncertainPublication: true } }]);
  expect(screen.getByLabelText("Body")).toHaveAttribute("readonly");
  for (const name of ["Check submission", "Create on GitHub", "Back"]) expect(screen.queryByRole("button", { name })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open GitHub manually" }));
  await waitFor(() => expect(bridge.openExternal).toHaveBeenCalledWith("https://github.com/eduardtomas1/inertia/issues"));
  fireEvent.click(screen.getByRole("button", { name: "Start another report" }));
  await waitFor(() => expect(screen.getByLabelText("What happened")).toHaveFocus());
  expect(screen.getByLabelText("What happened")).toHaveValue("");
  expect(current()?.status).toBe("retired");
});

it("opens a new form after a published report instead of the finished one", async () => {
  const { props } = fixture(saved("submitted", { issueUrl: "https://github.com/eduardtomas1/inertia/issues/7" }));
  render(<IssueReportSettings {...props} />);
  await waitFor(() => expect(screen.getByLabelText("What happened")).toBeEnabled());
  expect(screen.getByLabelText("What happened")).toHaveValue("");
});
