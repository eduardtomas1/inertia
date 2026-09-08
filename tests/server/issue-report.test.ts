import Database from "better-sqlite3";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
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
  const backendProfileController = { validateSelection: vi.fn((value: typeof selection) => value), readiness: vi.fn(async (): Promise<{ ready: boolean; message: string | null } | null> => null) };
  const deps = { store, snapshot, publisher, isolatedRuns, backendProfileController, providerInfo: () => [{ id: "claude", canRun: true }] as ProviderInfo[], send };
  const handler = createIssueReportCommandHandler(deps);
  const dispatch = async (command: import("../../src/renderer/src/lib/runtimeCommands").CommandWithoutId) => {
    await handler({} as WebSocket, { requestId: crypto.randomUUID(), ...command } as ClientCommand);
    const last = send.mock.calls.at(-1)![1];
    if (last.type !== "request.result" || last.result.kind !== "support.report") throw new Error("Unexpected response");
    return last.result.report!;
  };
  return { store, deps, handler, dispatch, snapshot, run, isolatedRuns, publisher, send, backendProfileController };
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
    expect(JSON.parse(evidence).selectedProject).toMatchObject({ chats: 0 });
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
  it("uses selected backend readiness without requiring native Claude login", async () => {
    const { dispatch, deps, run, backendProfileController } = setup();
    deps.providerInfo = () => [{ id: "claude", canRun: false }] as ProviderInfo[];
    const external = { ...selection, backendProfileId: "custom:report", backendProfileDisplayName: "Report backend", backendConfigurationRevision: 4 };
    backendProfileController.readiness.mockResolvedValueOnce({ ready: true, message: null });
    const draft = await dispatch({ type: "support.report.prepare", payload: { ...input, selection: external } });
    expect((await dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: 0 } })).status).toBe("preview");
    expect(backendProfileController.validateSelection).toHaveBeenCalledWith(external);
    expect(backendProfileController.readiness).toHaveBeenCalledWith(external, deps.providerInfo()[0]);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ selection: { modelSelection: external }, toolPolicy: "none" }));
  });
  it("rejects invalid backend selections before readiness or provider launch", async () => {
    const { dispatch, run, backendProfileController } = setup();
    backendProfileController.validateSelection.mockImplementationOnce(() => { throw new Error("Invalid backend with private diagnostic text"); });
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const failed = await dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: 0 } });
    expect(failed.status).toBe("failed");
    expect(failed.notice).not.toContain("private diagnostic text");
    expect(backendProfileController.readiness).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([null, { ready: false, message: "Backend requires a configured credential." }])("keeps an unready selected route on the manual path: %j", async (readiness) => {
    const { dispatch, deps, run, backendProfileController } = setup();
    deps.providerInfo = () => [{ id: "claude", canRun: readiness !== null }] as ProviderInfo[];
    backendProfileController.readiness.mockResolvedValueOnce(readiness);
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    expect((await dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: 0 } })).status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["ready", "rejected"])("ignores %s readiness after cancellation and a new unrelated draft", async (outcome) => {
    const { dispatch, run, backendProfileController } = setup();
    let resolve!: (value: { ready: boolean; message: null }) => void;
    let reject!: (error: Error) => void;
    backendProfileController.readiness.mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const pending = dispatch({ type: "support.report.validate", payload: { id: draft.id, revision: 0 } });
    expect((await dispatch({ type: "support.report.get" })).status).toBe("validating");
    await expect(dispatch({ type: "support.report.prepare", payload: input })).rejects.toThrow("pending report");
    await dispatch({ type: "support.report.cancel", payload: { id: draft.id } });
    const next = await dispatch({ type: "support.report.prepare", payload: { ...input, description: "A different problem with project selection." } });
    if (outcome === "ready") resolve({ ready: true, message: null }); else reject(new Error("Readiness failed after cancellation"));
    await pending;
    expect(await dispatch({ type: "support.report.get" })).toEqual(next);
    expect(run).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
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
  it("explicitly retires uncertain publication, preserves its preview across restart, and permits a fresh unrelated report", async () => {
    const { dispatch, publisher, store, deps, send } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const preview = await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: draft.title, body: draft.body } });
    publisher.create.mockImplementationOnce(async ({ beforePublish }) => { beforePublish(); throw new Error("Unknown outcome"); });
    const uncertain = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: preview.revision } });
    const checked = await dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: uncertain.revision } });
    expect(checked.status).toBe("uncertain");
    const retired = await dispatch({ type: "support.report.retire", payload: { id: draft.id, revision: checked.revision, acknowledgeUncertainPublication: true } });
    expect(retired).toMatchObject({ status: "retired", id: draft.id, title: preview.title, body: preview.body });
    const reopened = createIssueReportCommandHandler(deps);
    await reopened({} as WebSocket, { type: "support.report.get", requestId: crypto.randomUUID() });
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ result: { report: retired } });
    expect(store.readIssueReport()).toEqual(retired);
    for (const type of ["support.report.validate", "support.report.submit", "support.report.reconcile"] as const) {
      await expect(dispatch({ type, payload: { id: retired.id, revision: retired.revision } })).rejects.toThrow();
    }
    await expect(dispatch({ type: "support.report.edit", payload: { id: retired.id, revision: retired.revision, title: "Repost retired issue", body: preview.body } })).rejects.toThrow();
    const next = await dispatch({ type: "support.report.prepare", payload: { ...input, description: "A different problem with project selection." } });
    expect(next.id).not.toBe(retired.id);
    for (const type of ["support.report.validate", "support.report.submit", "support.report.reconcile"] as const) {
      await expect(dispatch({ type, payload: { id: retired.id, revision: retired.revision } })).rejects.toThrow("changed");
    }
    expect(publisher.create).toHaveBeenCalledTimes(1);
    expect(publisher.find).toHaveBeenCalledTimes(1);
  });
  it("refuses retirement while publication or reconciliation is pending and rejects stale confirmation", async () => {
    const { dispatch, publisher } = setup();
    let finishPublish!: () => void;
    publisher.create.mockImplementationOnce(({ beforePublish }) => { beforePublish(); return new Promise((_resolve, reject) => { finishPublish = () => reject(new Error("Unknown outcome")); }); });
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const preview = await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: draft.title, body: draft.body } });
    const publishing = dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: preview.revision } });
    const submitting = await dispatch({ type: "support.report.get" });
    await expect(dispatch({ type: "support.report.retire", payload: { id: draft.id, revision: submitting.revision, acknowledgeUncertainPublication: true } })).rejects.toThrow();
    finishPublish(); const uncertain = await publishing;
    let finishFind!: (url: string | null) => void;
    publisher.find.mockImplementationOnce(() => new Promise((resolve) => { finishFind = resolve; }));
    const checking = dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: uncertain.revision } });
    await expect(dispatch({ type: "support.report.retire", payload: { id: draft.id, revision: uncertain.revision, acknowledgeUncertainPublication: true } })).rejects.toThrow();
    finishFind(null); const checked = await checking;
    await expect(dispatch({ type: "support.report.retire", payload: { id: draft.id, revision: uncertain.revision, acknowledgeUncertainPublication: true } })).rejects.toThrow("changed");
    expect((await dispatch({ type: "support.report.retire", payload: { id: draft.id, revision: checked.revision, acknowledgeUncertainPublication: true } })).status).toBe("retired");
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
  it("requires review again when the final publication scrub changes an older saved preview", async () => {
    const { dispatch, store, deps, publisher, send } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    store.saveIssueReport({ ...draft, status: "preview", body: 'The chat stopped. {"accessToken":"SYNTHETIC_OLD_SECRET"}' });
    const reopened = createIssueReportCommandHandler(deps);
    const submit = async (revision: number) => reopened({} as WebSocket, { type: "support.report.submit", requestId: crypto.randomUUID(), payload: { id: draft.id, revision } });
    await submit(draft.revision);
    expect(publisher.create).not.toHaveBeenCalled();
    const scrubbed = store.readIssueReport() as IssueReport;
    expect(scrubbed).toMatchObject({ status: "preview", revision: draft.revision + 1 });
    expect(JSON.stringify(scrubbed)).not.toContain("SYNTHETIC_");
    expect(JSON.stringify(send.mock.calls.at(-1))).not.toContain("SYNTHETIC_");
    await submit(scrubbed.revision);
    expect(publisher.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(publisher.create.mock.calls)).not.toContain("SYNTHETIC_");
  });
  it("accepts only a complete URL in the fixed repository", () => {
    expect(verifiedIssueUrl("https://github.com/eduardtomas1/inertia/issues/123\n")).toBeTruthy();
    for (const invalid of ["https://github.com/attacker/inertia/issues/123", "https://github.com/eduardtomas1/inertia/issues/123/evil", "https://github.com/eduardtomas1/inertia/issues/123?token=secret"]) expect(verifiedIssueUrl(invalid)).toBeNull();
  });
});


it("upgrades schema 68 transactionally and retains saved report progress", () => {
  const database = new Database(":memory:");
  try {
    migrateRuntimeDatabase(database, 68);
    database.exec("CREATE TABLE retained_marker (value TEXT); INSERT INTO retained_marker VALUES ('kept');");
    database.exec("CREATE INDEX issue_report_draft ON agent_turns(id);");
    expect(() => migrateRuntimeDatabase(database)).toThrow();
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(68);
    database.exec("DROP INDEX issue_report_draft;");
    migrateRuntimeDatabase(database);
    database.prepare("INSERT INTO issue_report_draft VALUES (1, ?)").run(JSON.stringify({ description: "Safe saved report" }));
    migrateRuntimeDatabase(database);
    expect(database.prepare("SELECT value FROM retained_marker").pluck().get()).toBe("kept");
    expect(database.prepare("SELECT report_json FROM issue_report_draft").pluck().get()).toContain("Safe saved report");
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(69);
  } finally { database.close(); }
});


it.each([
  '{"api_key":"SYNTHETIC_SECRET_VALUE"}',
  String.raw`{"pass\u0077ord":"SYNTHETIC_DECODED_KEY_VALUE"}`,
  '{"apiToken":"SYNTHETIC_API_TOKEN","accessToken":"SYNTHETIC_ACCESS_TOKEN"}',
  '{"refreshToken":"SYNTHETIC_REFRESH_TOKEN","client_secret":"SYNTHETIC_CLIENT_SECRET"}',
  '{"password":"SYNTHETIC_PASSWORD_VALUE"}',
  '{"access_token":"SYNTHETIC_ACCESS_VALUE","refresh_token":"SYNTHETIC_REFRESH_VALUE"}',
  '{"clientSecret":"SYNTHETIC_CLIENT_VALUE","secret_access_key":"SYNTHETIC_KEY_VALUE"}',
  "'token': 'SYNTHETIC_TOKEN_VALUE'",
  '{"API_KEY":"SYNTHETIC_ESCAPED_\\\"SECRET_VALUE"}',
])("removes quoted secrets from prepare, edit and the final provider prompt: %s", async (privateText) => {
  const { dispatch, store } = setup();
  const description = `The chat stopped. Configuration follows:\n${privateText}`;
  const draft = await dispatch({ type: "support.report.prepare", payload: { ...input, description } });
  expect(JSON.stringify(store.readIssueReport())).not.toContain("SYNTHETIC_");
  expect(reportPrompt(draft)).not.toContain("SYNTHETIC_");
  // The final provider boundary also protects drafts created before a scrub update.
  expect(reportPrompt({ ...draft, description })).not.toContain("SYNTHETIC_");
  await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: draft.revision, title: "Chat failure", body: description } });
  expect(JSON.stringify(store.readIssueReport())).not.toContain("SYNTHETIC_");
});
