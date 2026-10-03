import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RuntimeStore } from "../../src/server/database";
import { createIssueReportCommandHandler } from "../../src/server/runtime/commands/issue-report-commands";
import { collectIssueEnvironment, newIssueReport } from "../../src/server/issue-report";
import { issueReportInputSchema, issueReportSchema, type IssueGitHubState, type IssueReport, type IssueReportInput } from "../../src/shared/issue-report";
import { scrubReportText } from "../../src/shared/issue-report-scrub";
import { ISSUE_GITHUB_MESSAGES, ISSUE_UNCERTAIN_REASONS } from "../../src/shared/issue-report-github";
import type { AppSnapshot, ClientCommand, ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { IssuePublicationError, verifiedIssueUrl } from "../../src/server/git/github-issue-report";
import type { IssueHostEvidence } from "../../src/node/runtime-issue-evidence-protocol";
import { INERTIA_VERSION } from "../../src/shared/version";

const input: IssueReportInput = { description: "The chat stops responding after cancelling a turn. Expected a new message to start.", steps: "", providerId: null, attachDiagnostics: true };
const host: IssueHostEvidence = { channel: "canary", osVersion: "15.1.0", diagnostics: "2026-10-03T10:00:00Z error app.runtime.crash x1" };
const stores: RuntimeStore[] = [];
const directories: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-issue-report-"));
  directories.push(directory);
  return join(directory, "inertia.sqlite");
}
function setup() {
  const store = new RuntimeStore(":memory:", process.cwd()); stores.push(store);
  const snapshot = () => store.shellSnapshot([]);
  const publisher = {
    status: vi.fn(async (): Promise<IssueGitHubState> => "ready"),
    create: vi.fn(async (value: { beforePublish(): void }) => { value.beforePublish(); return "https://github.com/eduardtomas1/inertia/issues/999"; }),
    find: vi.fn(async (): Promise<string | null> => null),
  };
  const evidence = { collect: vi.fn(async (_attach: boolean): Promise<IssueHostEvidence | null> => host) };
  const send = vi.fn<(socket: WebSocket, event: ServerEvent) => void>();
  const providers = [{ id: "claude", version: "2.0.14 (Claude Code)" }] as ProviderInfo[];
  const clock = { now: 1_000_000 };
  const deps = { store, snapshot, publisher, evidence, providerInfo: () => providers, send, now: () => clock.now };
  const handler = createIssueReportCommandHandler(deps);
  const result = async (command: import("../../src/renderer/src/lib/runtimeCommands").CommandWithoutId) => {
    await handler({} as WebSocket, { requestId: crypto.randomUUID(), ...command } as ClientCommand);
    const last = send.mock.calls.at(-1)![1];
    if (last.type !== "request.result" || last.result.kind !== "support.report") throw new Error("Unexpected response");
    return last.result;
  };
  const dispatch = async (command: import("../../src/renderer/src/lib/runtimeCommands").CommandWithoutId) => (await result(command)).report!;
  return { store, deps, handler, dispatch, result, snapshot, publisher, evidence, send, clock };
}

describe("issue reports", () => {
  it("builds the exact public preview from code-generated evidence and the requested diagnostics", async () => {
    const { dispatch, evidence } = setup();
    const preview = await dispatch({ type: "support.report.prepare", payload: { ...input, steps: "1. Start a turn\n2. Cancel it\n3. Send again", providerId: "claude" } });
    expect(evidence.collect).toHaveBeenCalledWith(true);
    expect(preview).toMatchObject({ status: "preview", revision: 0, providerId: "claude", attachDiagnostics: true, notice: "", title: "The chat stops responding after cancelling a turn. Expected a new message to start." });
    expect(preview.body).toContain("## What happened\n\nThe chat stops responding");
    expect(preview.body).toContain("## Steps to reproduce\n\n1. Start a turn\n2. Cancel it\n3. Send again");
    expect(preview.body).toContain(`- Inertia: ${INERTIA_VERSION} (canary)`);
    expect(preview.body).toMatch(/- OS: (?:macOS|Windows|Linux|other) 15\.1\.0 \(/u);
    expect(preview.body).toContain("- Provider: claude version unknown");
    expect(preview.body).toContain("```text\n2026-10-03T10:00:00Z error app.runtime.crash x1\n```");
  });

  it("asks for no diagnostics when the box is off and never accepts renderer-supplied evidence", async () => {
    const { dispatch, evidence } = setup();
    evidence.collect.mockResolvedValueOnce({ ...host, diagnostics: "" });
    const preview = await dispatch({ type: "support.report.prepare", payload: { ...input, attachDiagnostics: false } });
    expect(evidence.collect).toHaveBeenCalledWith(false);
    expect(preview.body).toContain("## Diagnostics\n\nNot attached.");
    expect(preview.body).toContain("## Steps to reproduce\n\nNot provided.");
    for (const extra of [{ evidence: "{}" }, { diagnostics: "renderer text" }, { projectId: null }, { selection: {} }]) {
      expect(issueReportInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });

  it("states when diagnostics are empty or could not be collected", async () => {
    const { dispatch, evidence } = setup();
    evidence.collect.mockResolvedValueOnce({ ...host, diagnostics: "" });
    expect((await dispatch({ type: "support.report.prepare", payload: input })).body).toContain("No diagnostics were recorded in the last 24 hours.");
    evidence.collect.mockResolvedValueOnce(null);
    const unavailable = await dispatch({ type: "support.report.prepare", payload: input });
    expect(unavailable.body).toContain("Diagnostics could not be collected.");
    expect(unavailable.body).toContain(`- Inertia: ${INERTIA_VERSION} (channel unknown)`);
  });

  it("projects only safe codes; rejects hostile lifecycle metadata", () => {
    const { store, snapshot } = setup();
    store.createProject("PRIVATE PROJECT", process.cwd());
    const current = snapshot();
    const hostile = { ...current, lifecycleDiagnostics: { actionableState: "read /home/secrets", password: "secret" } } as unknown as AppSnapshot;
    const environment = collectIssueEnvironment({ ...input, providerId: "claude" }, { snapshot: hostile, providers: [{ id: "claude", version: "/home/alice/claude" } as ProviderInfo], host: null });
    expect(environment).toContain("- Lifecycle: unavailable");
    expect(environment).toContain("- Provider: claude version unknown");
    const report = newIssueReport(input, { snapshot: hostile, providers: [], host: null });
    for (const value of ["password", "/home", "secrets", "PRIVATE", process.cwd()]) expect(JSON.stringify(report)).not.toContain(value);
  });

  it("shortens a long first line into a title at a word boundary", () => {
    const { snapshot } = setup();
    const description = `${"Sending the next message after cancelling a running chat leaves it waiting ".repeat(3)}forever.\nMore detail.`;
    const report = newIssueReport({ ...input, description }, { snapshot: snapshot(), providers: [], host });
    expect(report.title).toBe("Sending the next message after cancelling a running chat leaves it waiting Sending the next message after cancelling a…");
    expect(report.title.length).toBeLessThanOrEqual(120);
    expect(newIssueReport({ ...input, description: "Short title line.\nBody" }, { snapshot: snapshot(), providers: [], host }).title).toBe("Short title line.");
  });

  it("uses the installed provider version when it is safe", () => {
    const { snapshot } = setup();
    expect(collectIssueEnvironment({ ...input, providerId: "codex" }, { snapshot: snapshot(), providers: [{ id: "codex", version: "0.46.0" } as ProviderInfo], host })).toContain("- Provider: codex 0.46.0");
  });

  it("reports the GitHub CLI state on request", async () => {
    const { result, publisher } = setup();
    publisher.status.mockResolvedValueOnce("signed-out");
    expect(await result({ type: "support.report.github" })).toMatchObject({ report: null, github: "signed-out" });
    expect((await result({ type: "support.report.get" })).github).toBeUndefined();
  });

  it("runs one sign-in check at a time and reuses its result for 30 seconds", async () => {
    const { result, publisher, clock } = setup();
    let finish!: (state: IssueGitHubState) => void;
    publisher.status.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = result({ type: "support.report.github" });
    const second = result({ type: "support.report.github" });
    await vi.waitFor(() => expect(publisher.status).toHaveBeenCalledOnce());
    finish("signed-out");
    expect((await first).github).toBe("signed-out");
    expect((await second).github).toBe("signed-out");
    clock.now += 29_000;
    expect((await result({ type: "support.report.github" })).github).toBe("signed-out");
    expect(publisher.status).toHaveBeenCalledOnce();
    clock.now += 2_000;
    expect((await result({ type: "support.report.github" })).github).toBe("ready");
    expect(publisher.status).toHaveBeenCalledTimes(2);
  });

  it("publishes hand edits exactly and rejects stale writes", async () => {
    const { dispatch, publisher, store } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    const body = `${draft.body}\n\nI also saw this after restarting.`;
    const edited = await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: "Cancelled chat stays waiting", body } });
    expect(edited).toMatchObject({ status: "preview", revision: 1, title: "Cancelled chat stays waiting", body, notice: "" });
    await expect(dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: 0, title: "Stale title", body: "Must not replace the current report." } })).rejects.toThrow("changed");
    expect((store.readIssueReport() as IssueReport).body).toBe(body);
    const published = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: edited.revision } });
    expect(published).toMatchObject({ status: "submitted", issueUrl: "https://github.com/eduardtomas1/inertia/issues/999", notice: "Issue created in eduardtomas1/inertia." });
    expect(publisher.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Cancelled chat stays waiting", body }));
  });

  it.each(["missing", "signed-out", "offline", "rate-limited", "repository", "timeout", "unknown"] as const)("keeps a %s failure of the sign-in check retryable with its own message", async (reason) => {
    const { dispatch, publisher } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    publisher.create.mockImplementationOnce(async () => { throw new IssuePublicationError(reason); });
    const failed = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: draft.revision } });
    expect(failed).toMatchObject({ status: "failed", notice: ISSUE_GITHUB_MESSAGES[reason] });
    expect((await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: failed.revision } })).status).toBe("submitted");
  });

  it.each(["signed-out", "rate-limited", "repository", "offline", "timeout", "unknown"] as const)("never resubmits after a %s failure once publication started; Check submission resolves it", async (reason) => {
    const { dispatch, publisher } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    publisher.create.mockImplementationOnce(async ({ beforePublish }) => { beforePublish(); throw new IssuePublicationError(reason); });
    const uncertain = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: draft.revision } });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.notice).toBe(`${ISSUE_UNCERTAIN_REASONS[reason]}GitHub may still have received the issue. Check submission before trying again; a second issue is never created automatically.`);
    await expect(dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: uncertain.revision } })).rejects.toThrow("pending submission");
    publisher.find.mockResolvedValueOnce("https://github.com/eduardtomas1/inertia/issues/999");
    expect((await dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: uncertain.revision } })).status).toBe("submitted");
    expect(publisher.create).toHaveBeenCalledOnce();
  });

  it("blocks duplicate submits and reconciles uncertain delivery without posting again", async () => {
    const { dispatch, publisher } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    publisher.create.mockImplementationOnce(async ({ beforePublish }) => { beforePublish(); throw new Error("uncertain network outcome with secret"); });
    const uncertain = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: draft.revision } });
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.notice).not.toContain("secret");
    await expect(dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: uncertain.revision } })).rejects.toThrow("pending submission");
    await expect(dispatch({ type: "support.report.prepare", payload: input })).rejects.toThrow("pending GitHub submission");
    await expect(dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: uncertain.revision, title: "Changed", body: "Changed while uncertain." } })).rejects.toThrow("cannot be changed");
    publisher.find.mockRejectedValueOnce(new IssuePublicationError("offline"));
    const unchecked = await dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: uncertain.revision } });
    expect(unchecked).toMatchObject({ status: "uncertain", notice: `GitHub could not be checked. ${ISSUE_GITHUB_MESSAGES.offline}` });
    publisher.find.mockResolvedValueOnce("https://github.com/eduardtomas1/inertia/issues/999");
    const published = await dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: unchecked.revision } });
    expect(published.status).toBe("submitted");
    expect(publisher.create).toHaveBeenCalledTimes(1);
  });

  it("blocks a new report while a publication is in flight, even across the evidence wait", async () => {
    const { dispatch, publisher, evidence } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    let finish!: (url: string) => void;
    publisher.create.mockImplementationOnce(({ beforePublish }) => { beforePublish(); return new Promise((resolve) => { finish = resolve; }); });
    let release!: (value: IssueHostEvidence) => void;
    evidence.collect.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const preparing = dispatch({ type: "support.report.prepare", payload: { ...input, description: "A different problem that should not replace it." } });
    const publishing = dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: draft.revision } });
    await vi.waitFor(() => expect(publisher.create).toHaveBeenCalledOnce());
    release(host);
    await expect(preparing).rejects.toThrow("pending GitHub submission");
    finish("https://github.com/eduardtomas1/inertia/issues/999");
    expect((await publishing).id).toBe(draft.id);
  });

  it("explicitly retires uncertain publication, preserves its preview across restart, and permits a fresh unrelated report", async () => {
    const { dispatch, publisher, store, deps, send } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    publisher.create.mockImplementationOnce(async ({ beforePublish }) => { beforePublish(); throw new Error("Unknown outcome"); });
    const uncertain = await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: draft.revision } });
    const checked = await dispatch({ type: "support.report.reconcile", payload: { id: draft.id, revision: uncertain.revision } });
    expect(checked.status).toBe("uncertain");
    const retired = await dispatch({ type: "support.report.retire", payload: { id: draft.id, revision: checked.revision, acknowledgeUncertainPublication: true } });
    expect(retired).toMatchObject({ status: "retired", id: draft.id, title: draft.title, body: draft.body });
    const reopened = createIssueReportCommandHandler(deps);
    await reopened({} as WebSocket, { type: "support.report.get", requestId: crypto.randomUUID() });
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ result: { report: retired } });
    expect(store.readIssueReport()).toEqual(retired);
    for (const type of ["support.report.submit", "support.report.reconcile"] as const) {
      await expect(dispatch({ type, payload: { id: retired.id, revision: retired.revision } })).rejects.toThrow();
    }
    await expect(dispatch({ type: "support.report.edit", payload: { id: retired.id, revision: retired.revision, title: "Repost retired issue", body: draft.body } })).rejects.toThrow();
    const next = await dispatch({ type: "support.report.prepare", payload: { ...input, description: "A different problem with project selection." } });
    expect(next.id).not.toBe(retired.id);
    for (const type of ["support.report.submit", "support.report.reconcile"] as const) {
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
    const publishing = dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: draft.revision } });
    const submitting = await dispatch({ type: "support.report.get" });
    expect(submitting.status).toBe("submitting");
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

  it("turns a publication interrupted by a restart into an uncertain report", async () => {
    const { dispatch, store, deps } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    store.saveIssueReport({ ...draft, status: "submitting" });
    createIssueReportCommandHandler(deps);
    expect(store.readIssueReport()).toMatchObject({ status: "uncertain", revision: draft.revision + 1 });
  });

  it("requires review again when the final publication scrub changes an older saved preview", async () => {
    const { dispatch, store, deps, publisher, send } = setup();
    const draft = await dispatch({ type: "support.report.prepare", payload: input });
    store.saveIssueReport({ ...draft, body: 'The chat stopped. {"accessToken":"SYNTHETIC_OLD_SECRET"}' });
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

  it("scrubs secrets, URLs and portable private paths from user text", () => {
    const dirty = "Problem ghp_privateToken123 /home/alice/.ssh/key C:\\Users\\alice\\secret.txt \\\\server\\share\\private ~/private\nAUTH_KEY=never-copy\npassword: hidden\nBearer never-copy\nhttps://example.com/private?q=secret\nalice@example.com";
    const clean = scrubReportText(dirty);
    for (const secret of ["privateToken", "alice", "never-copy", "hidden", "example.com", "server"]) expect(clean).not.toContain(secret);
    expect(scrubReportText("x".repeat(100_000))).toHaveLength(8_000);
    expect(issueReportInputSchema.safeParse({ ...input, description: "x".repeat(8001) }).success).toBe(false);
    expect(issueReportInputSchema.safeParse({ ...input, directory: "/home" }).success).toBe(false);
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
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  } finally { database.close(); }
});

it.each([
  ["validating", "preview", ""],
  ["draft", "preview", ""],
  ["cancelled", "preview", ""],
  ["failed", "preview", ""],
  ["uncertain", "uncertain", "Check GitHub before proceeding."],
  ["retired", "retired", "Check GitHub before proceeding."],
  ["submitting", "submitting", "Check GitHub before proceeding."],
  ["submitted", "submitted", "Check GitHub before proceeding."],
  ["preview", "preview", "Check GitHub before proceeding."],
])("upgrades a saved %s report from schema 87 to the reviewed preview shape", (status, expected, notice) => {
  const database = new Database(":memory:");
  try {
    migrateRuntimeDatabase(database, 87);
    const legacy = {
      id: "11111111-1111-4111-8111-111111111111", revision: 4, status, description: "The chat stopped after cancelling.", projectId: null,
      selection: { harnessId: "claude-agent-sdk", modelId: "claude-test" }, evidence: "{}", answer: "Advisory text", title: "Cancelled chat",
      body: "## Problem\n\nThe chat stopped after cancelling.", notice: "Check GitHub before proceeding.", issueUrl: null,
    };
    database.prepare("INSERT INTO issue_report_draft VALUES (1, ?)").run(JSON.stringify(legacy));
    database.prepare("CREATE TABLE unrelated_marker (value TEXT)").run();
    migrateRuntimeDatabase(database);
    const upgraded = JSON.parse(database.prepare("SELECT report_json FROM issue_report_draft").pluck().get() as string) as unknown;
    expect(issueReportSchema.parse(upgraded)).toEqual({
      id: legacy.id, revision: 4, status: expected, description: legacy.description, steps: "", providerId: null, attachDiagnostics: false,
      title: legacy.title, body: legacy.body, notice, issueUrl: null,
    });
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  } finally { database.close(); }
});

it("keeps a published report's link and turns an interrupted publication uncertain after the upgrade", () => {
  const path = temporaryDatabase();
  const database = new Database(path);
  const legacy = { id: "11111111-1111-4111-8111-111111111111", revision: 2, description: "The chat stopped after cancelling.", projectId: null, selection: {}, evidence: "{}", answer: "", title: "Cancelled chat", body: "Body text long enough.", notice: "", issueUrl: null };
  try {
    migrateRuntimeDatabase(database, 87);
    database.prepare("INSERT INTO issue_report_draft VALUES (1, ?)").run(JSON.stringify({ ...legacy, status: "submitted", issueUrl: "https://github.com/eduardtomas1/inertia/issues/7" }));
    migrateRuntimeDatabase(database);
    expect(issueReportSchema.parse(JSON.parse(database.prepare("SELECT report_json FROM issue_report_draft").pluck().get() as string))).toMatchObject({ status: "submitted", issueUrl: "https://github.com/eduardtomas1/inertia/issues/7" });
    database.prepare("UPDATE issue_report_draft SET report_json = ?").run(JSON.stringify({ ...legacy, status: "submitting", steps: "", providerId: null, attachDiagnostics: false, projectId: undefined, selection: undefined, evidence: undefined, answer: undefined }));
  } finally { database.close(); }
  const store = new RuntimeStore(path, process.cwd()); stores.push(store);
  createIssueReportCommandHandler({ store, snapshot: () => store.shellSnapshot([]), providerInfo: () => [], publisher: { status: vi.fn(), create: vi.fn(), find: vi.fn() }, send: vi.fn() });
  expect(store.readIssueReport()).toMatchObject({ status: "uncertain", revision: 3 });
});

it.each(["not json", "[1, 2]", '"text"'])("leaves a malformed saved report untouched and starts without it: %s", async (value) => {
  const path = temporaryDatabase();
  const database = new Database(path);
  try {
    migrateRuntimeDatabase(database, 87);
    database.prepare("INSERT INTO issue_report_draft VALUES (1, ?)").run(value);
    migrateRuntimeDatabase(database);
    expect(database.prepare("SELECT report_json FROM issue_report_draft").pluck().get()).toBe(value);
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
  } finally { database.close(); }
  const store = new RuntimeStore(path, process.cwd()); stores.push(store);
  const send = vi.fn<(socket: WebSocket, event: ServerEvent) => void>();
  const handler = createIssueReportCommandHandler({ store, snapshot: () => store.shellSnapshot([]), providerInfo: () => [], publisher: { status: vi.fn(), create: vi.fn(), find: vi.fn() }, send });
  await handler({} as WebSocket, { type: "support.report.get", requestId: crypto.randomUUID() });
  expect(send.mock.calls.at(-1)?.[1]).toMatchObject({ result: { kind: "support.report", report: null } });
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
])("removes quoted secrets from prepare, edit and publication: %s", async (privateText) => {
  const { dispatch, store, publisher } = setup();
  const description = `The chat stopped. Configuration follows:\n${privateText}`;
  const draft = await dispatch({ type: "support.report.prepare", payload: { ...input, description, steps: privateText } });
  expect(JSON.stringify(store.readIssueReport())).not.toContain("SYNTHETIC_");
  const edited = await dispatch({ type: "support.report.edit", payload: { id: draft.id, revision: draft.revision, title: "Chat failure", body: description } });
  expect(JSON.stringify(store.readIssueReport())).not.toContain("SYNTHETIC_");
  await dispatch({ type: "support.report.submit", payload: { id: draft.id, revision: edited.revision } });
  expect(JSON.stringify(publisher.create.mock.calls)).not.toContain("SYNTHETIC_");
});
