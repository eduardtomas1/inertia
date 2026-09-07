import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RuntimeStore } from "../../src/server/database";
import { createIssueReportCommandHandler } from "../../src/server/runtime/commands/issue-report-commands";
import { collectIssueEvidence, newIssueReport, parseReportAnswer, reportPrompt } from "../../src/server/issue-report";
import { issueReportInputSchema, scrubReportText, type IssueReport } from "../../src/shared/issue-report";
import { providerNativeModelSelection, modelSelectionSchema } from "../../src/shared/model-routing";
import type { AppSnapshot, ClientCommand, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import type { IsolatedRunController } from "../../src/server/runtime/reviews/isolated-run-controller";
import { verifiedIssueUrl } from "../../src/server/git/github-issue-report";

const selection = modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "claude", modelId: "claude-test", reasoningEffort: "high" }));
const input = { description: "The chat stops responding after cancelling a turn. Expected a new message to start.", projectId: null, selection };
const stores: RuntimeStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
function setup() {
  const store = new RuntimeStore(":memory:", process.cwd()); stores.push(store);
  const snapshot = () => store.shellSnapshot([]);
  const publisher = { create: vi.fn(async (value: { beforePublish(): void }) => { value.beforePublish(); return "https://github.com/eduardtomas1/inertia/issues/999"; }), find: vi.fn(async (): Promise<string | null> => null) };
  const run = vi.fn(async () => ({ value: "The evidence cannot confirm reproduction. Does cancelling and sending again reproduce it?" }));
  const isolatedRuns = { has: vi.fn(() => false), run, stopConversation: vi.fn() } as unknown as IsolatedRunController<WebSocket>;
  const send = vi.fn<(socket: WebSocket, event: ServerEvent) => void>();
  const deps = { store, snapshot, publisher, isolatedRuns, providerInfo: () => [{ id: "claude", canRun: true }] as ProviderInfo[], send };
  const handler = createIssueReportCommandHandler(deps);
  const dispatch = async (command: import("../../src/renderer/src/lib/runtimeCommands").CommandWithoutId) => {
    await handler({} as WebSocket, { requestId: crypto.randomUUID(), ...command } as ClientCommand);
    const last = send.mock.calls.at(-1)![1];
    if (last.type !== "request.result" || last.result.kind !== "support.report") throw new Error("Unexpected response");
    return last.result.report!;
  };
  return { store, deps, handler, dispatch, snapshot, run, isolatedRuns, publisher, send };
}

describe("private issue reports", () => {
  it("scrubs secrets, configuration, URLs and portable private paths without copying raw evidence", () => {
    const dirty = "Problem ghp_privateToken123 /home/alice/.ssh/key C:\\Users\\alice\\secret.txt \\\\server\\share\\private ~/private\nAUTH_KEY=never-copy\npassword: hidden\nBearer never-copy\nhttps://example.com/private?q=secret\nalice@example.com";
    const clean = scrubReportText(dirty);
    for (const secret of ["privateToken", "alice", "never-copy", "hidden", "example.com", "server"]) expect(clean).not.toContain(secret);
    expect(scrubReportText("x".repeat(100_000))).toHaveLength(8_000);
    expect(issueReportInputSchema.safeParse({ ...input, description: "x".repeat(8001) }).success).toBe(false);
    expect(issueReportInputSchema.safeParse({ ...input, directory: "/home" }).success).toBe(false);
    expect(() => parseReportAnswer('{"assessment":"Run a command", "command":"rm -rf /"}')).toThrow();
    expect(() => parseReportAnswer("not JSON")).toThrow();
    expect(() => parseReportAnswer(JSON.stringify({ assessment: "x".repeat(4001) }))).toThrow();
  });
  it("projects only safe codes and explicit selected-project counts; rejects hostile metadata", () => {
    const { store, snapshot } = setup();
    const project = store.createProject("PRIVATE PROJECT", process.cwd());
    const current = snapshot();
    const evidence = collectIssueEvidence(current, project.id);
    expect(evidence).toContain('"chats": 0');
    expect(evidence).not.toContain(project.id);
    expect(evidence).not.toContain("PRIVATE");
    expect(evidence).not.toContain(process.cwd());
    expect(() => collectIssueEvidence(current, crypto.randomUUID())).toThrow("no longer available");
    const hostile = { ...current, lifecycleDiagnostics: { actionableState: "read /home/secrets", password: "secret" } } as unknown as AppSnapshot;
    expect(collectIssueEvidence(hostile, null)).toContain('"lifecycle": "unavailable"');
    expect(reportPrompt(newIssueReport(input, hostile))).not.toContain("password");
  });
  it("propagates the exact chosen model and reasoning with a native no-tools policy and bounds", async () => {
    const { dispatch, run } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const preview = await dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: draft.revision } });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: "issue-report", selection: { modelSelection: selection }, timeoutMs: 90_000, outputLimitChars: 8000, toolPolicy: "none", interactionPolicy: "fail-closed" }));
    expect(preview.status).toBe("preview");
    expect(preview.body).toContain("cannot confirm reproduction");
  });
  it("keeps an unsupported provider on the manual preview path", async () => {
    const { dispatch, run } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: { ...input, selection: modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "codex" })) } });
    const failed = await dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: 0 } });
    expect(failed.notice).toContain("tools disabled");
    expect(run).not.toHaveBeenCalled();
    const preview = await dispatch({ type: "support.report.edit", payload: { id: failed.id, revision: failed.revision, title: failed.title, body: failed.body } });
    expect(preview.status).toBe("preview");
  });
  it("persists draft edits, rejects stale writes, and recovers interrupted validation", async () => {
    const { dispatch, store, deps } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: "Clear report title", body: "The problem reproduces when cancelling twice." } });
    await expect(dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: "Stale title", body: "Must not replace the current report." } })).rejects.toThrow("changed");
    const saved = store.readIssueReport() as IssueReport;
    expect(saved.title).toBe("Clear report title");
    store.saveIssueReport({ ...saved, status: "validating" });
    createIssueReportCommandHandler(deps);
    expect(store.readIssueReport()).toMatchObject({ status: "failed", title: "Clear report title" });
  });
  it("cancels validation and ignores its late result; a retry remains possible", async () => {
    const { dispatch, run, isolatedRuns } = setup();
    let finish!: (value: { value: string }) => void;
    run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const validating = dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: 0 } });
    const cancelled = await dispatch({ type: "support.report.cancel", payload: { id: draft.id } });
    expect(cancelled.status).toBe("cancelled");
    expect(isolatedRuns.stopConversation).toHaveBeenCalledWith(draft.id, "issue-report");
    finish({ value: "Unwanted late result" }); await validating;
    expect((await dispatch({ type: "support.report.get" })).answer).toBe("");
    expect((await dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: cancelled.revision } })).status).toBe("preview");
  });
  it("blocks duplicate submits and reconciles uncertain delivery without posting again", async () => {
    const { dispatch, publisher } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const preview = await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: draft.title, body: draft.body } });
    publisher.create.mockImplementationOnce(async ({ beforePublish }) => { beforePublish(); throw new Error("uncertain network outcome with secret"); });
    const uncertain = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: preview.revision } });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.notice).not.toContain("secret");
    await expect(dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: uncertain.revision } })).rejects.toThrow("pending submission");
    await expect(dispatch({ type: "support.report.prepare", payload: input })).rejects.toThrow("pending report");
    publisher.find.mockResolvedValueOnce("https://github.com/eduardtomas1/inertia/issues/999");
    const published = await dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: uncertain.revision } });
    expect(published.status).toBe("submitted");
    expect(publisher.create).toHaveBeenCalledTimes(1);
  });
  it("retains a retryable preview when authentication fails before publication", async () => {
    const { dispatch, publisher } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const preview = await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: draft.title, body: draft.body } });
    publisher.create.mockRejectedValueOnce(new Error("not authenticated"));
    const failed = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: preview.revision } });
    expect(failed.status).toBe("preview");
    expect(failed.notice).toContain("gh auth login");
    const published = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: failed.revision } });
    expect(published.status).toBe("submitted");
  });
  it("accepts only a complete URL in the fixed repository", () => {
    expect(verifiedIssueUrl("https://github.com/eduardtomas1/inertia/issues/123\n")).toBeTruthy();
    for (const invalid of ["https://github.com/attacker/inertia/issues/123", "https://github.com/eduardtomas1/inertia/issues/123/evil", "https://github.com/eduardtomas1/inertia/issues/123?token=secret"]) expect(verifiedIssueUrl(invalid)).toBeNull();
  });
});
