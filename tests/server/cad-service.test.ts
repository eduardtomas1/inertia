// @inertia-test-suite portable
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CadError, HOST_UNREADABLE } from "../../src/server/cad/cad-hosts";
import {
  type CadChange,
  type CadServiceOptions,
  checkDestination,
  copyName,
  CadService,
} from "../../src/server/cad/cad-service";
import {
  ACAD_DOCUMENT_ID,
  cadDocument,
  deferred,
  fakeCadHost,
  type FakeCadHost,
  previewAnswer,
  settle,
  SKP_DOCUMENT_ID,
} from "../helpers/cad-fake-host";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

const roots: string[] = [];
const START = Date.UTC(2026, 10, 21, 12, 0, 0);
const TTL_MS = 30 * 60 * 1000;
// Under OpenCode's 30-second host-tool timeout.
const READ_TIMEOUT_MS = 28_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

async function stateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inertia-cad-service-"));
  roots.push(root);
  return root;
}

const SET_TAG = { op: "skp.set_tag", ids: ["11"], tag: "Walls" };
const CHANGE: CadChange = { op: "skp.set_tag", target: "Group 11", field: "tag", before: "Untagged", after: "Walls" };

function sketchUpHost(): FakeCadHost {
  return fakeCadHost("sketchup", {
    preview: () => previewAnswer(SKP_DOCUMENT_ID, [CHANGE]),
    apply: () => ({ status: "applied", created: [{ id: "99" }] }),
    selection: () => ({ items: [{ id: "11" }] }),
    query: () => ({ items: [], nextCursor: null }),
    info: () => ({ units: "mm", layers: [] }),
    capture: () => ({ documentId: SKP_DOCUMENT_ID, width: 10, height: 8, pngBase64: "AAAA", scene: null }),
    save_copy: (params) => ({ saved: params.path }),
  });
}

async function service(
  hosts = [sketchUpHost()],
  clock = { now: START },
  options: Partial<CadServiceOptions> = {},
) {
  const directory = await stateDirectory();
  const cad = new CadService({ hosts, stateDirectory: directory, now: () => clock.now, ...options });
  return { cad, directory, clock, host: hosts[0]! };
}

async function propose(cad: CadService, operations: Array<{ op: string; [key: string]: unknown }> = [SET_TAG]) {
  const preview = await cad.preview({ documentId: SKP_DOCUMENT_ID, operations });
  expect(preview.proposalId).toMatch(/^cadp_[A-Za-z0-9_-]+$/u);
  return preview.proposalId!;
}

async function rejection(promise: Promise<unknown>): Promise<CadError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CadError);
  return error as CadError;
}

describe("CadService reads", () => {
  it("merges every host's status and lists documents separately", async () => {
    const autocad = fakeCadHost("autocad");
    const sketchup = sketchUpHost();
    const { cad } = await service([autocad, sketchup]);
    const status = await cad.status();
    expect(status.hosts).toEqual([
      { app: "autocad", state: "connected", bridgeVersion: "1.0.0" },
      { app: "sketchup", state: "connected", bridgeVersion: "1.0.0" },
    ]);
    expect(status.documents.map(({ documentId }) => documentId)).toEqual([ACAD_DOCUMENT_ID, SKP_DOCUMENT_ID]);
  });

  it("asks only the named app for status", async () => {
    const autocad = fakeCadHost("autocad");
    const sketchup = sketchUpHost();
    const { cad } = await service([autocad, sketchup]);
    const status = await cad.status("sketchup");
    expect(status.hosts.map(({ app }) => app)).toEqual(["sketchup"]);
    expect(autocad.statusCalls).toBe(0);
  });

  it("sets up only the named app, and every app in order without one", async () => {
    const autocad = fakeCadHost("autocad");
    const sketchup = sketchUpHost();
    const { cad } = await service([autocad, sketchup]);
    expect((await cad.setup("sketchup")).results.map(({ app }) => app)).toEqual(["sketchup"]);
    expect(autocad.setupCalls).toBe(0);
    expect((await cad.setup()).results.map(({ app }) => app)).toEqual(["autocad", "sketchup"]);
    expect(sketchup.setupCalls).toBe(2);
  });

  it("forwards selection, query and info to the owning host with the read timeout", async () => {
    const { cad, host } = await service();
    expect(await cad.selection({ documentId: SKP_DOCUMENT_ID, limit: 5 })).toEqual({ items: [{ id: "11" }] });
    expect(await cad.query({ documentId: SKP_DOCUMENT_ID, tag: "Walls" })).toEqual({ items: [], nextCursor: null });
    expect(await cad.info({ documentId: SKP_DOCUMENT_ID })).toEqual({ units: "mm", layers: [] });
    expect(host.calls.map(({ method, params, options }) => [method, params, options.documentId, options.timeoutMs]))
      .toEqual([
        ["selection", { documentId: SKP_DOCUMENT_ID, limit: 5 }, SKP_DOCUMENT_ID, READ_TIMEOUT_MS],
        ["query", { documentId: SKP_DOCUMENT_ID, tag: "Walls" }, SKP_DOCUMENT_ID, READ_TIMEOUT_MS],
        ["info", { documentId: SKP_DOCUMENT_ID }, SKP_DOCUMENT_ID, READ_TIMEOUT_MS],
      ]);
  });

  it("turns an info answer of the wrong shape into HOST_ERROR", async () => {
    const host = sketchUpHost();
    host.handlers.info = () => "units: mm";
    const { cad } = await service([host]);
    expect((await rejection(cad.info({ documentId: SKP_DOCUMENT_ID }))).code).toBe("HOST_ERROR");
  });

  it("refuses a documentId no host owns", async () => {
    const { cad } = await service();
    const error = await rejection(cad.selection({ documentId: "rvt:1:2" }));
    expect(error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("turns a read answer of the wrong shape into HOST_ERROR", async () => {
    const host = sketchUpHost();
    host.handlers.selection = () => ["not", "a", "record"];
    host.handlers.capture = () => ({ documentId: SKP_DOCUMENT_ID, width: "wide" });
    const { cad } = await service([host]);
    expect((await rejection(cad.selection({ documentId: SKP_DOCUMENT_ID }))).code).toBe("HOST_ERROR");
    expect((await rejection(cad.capture({ documentId: SKP_DOCUMENT_ID, maxWidth: 64, maxHeight: 64 }))).code)
      .toBe("HOST_ERROR");
  });

  it("decodes a capture", async () => {
    const { cad, host } = await service();
    const capture = await cad.capture({ documentId: SKP_DOCUMENT_ID, maxWidth: 320, maxHeight: 200 });
    expect(capture).toEqual({ documentId: SKP_DOCUMENT_ID, width: 10, height: 8, pngBase64: "AAAA", scene: null });
    expect(host.calls[0]!.params).toEqual({ documentId: SKP_DOCUMENT_ID, maxWidth: 320, maxHeight: 200 });
    expect(host.calls[0]!.options.timeoutMs).toBe(READ_TIMEOUT_MS);
  });

  it.each([
    { label: "extents", extra: { extents: true } },
    { label: "a bbox", extra: { bbox: { min: [0, 0], max: [10, 10] } } },
  ])("refuses $label for a SketchUp capture without calling the host", async ({ extra }) => {
    const { cad, host } = await service();
    const error = await rejection(cad.capture({ documentId: SKP_DOCUMENT_ID, maxWidth: 64, maxHeight: 64, ...extra }));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("only in AutoCAD");
    expect(host.calls).toEqual([]);
  });

  it("captures SketchUp's current view when extents is false", async () => {
    const { cad, host } = await service();
    await cad.capture({ documentId: SKP_DOCUMENT_ID, maxWidth: 64, maxHeight: 64, extents: false });
    expect(host.calls.map(({ method }) => method)).toEqual(["capture"]);
  });

  it("forwards extents and bbox to AutoCAD", async () => {
    const autocad = fakeCadHost("autocad", {
      capture: () => ({ documentId: ACAD_DOCUMENT_ID, width: 64, height: 64, pngBase64: "AAAA" }),
    });
    const { cad } = await service([autocad]);
    const bbox = { min: [0, 0], max: [1200, 800] };
    await cad.capture({ documentId: ACAD_DOCUMENT_ID, maxWidth: 640, maxHeight: 480, extents: true });
    await cad.capture({ documentId: ACAD_DOCUMENT_ID, maxWidth: 640, maxHeight: 480, bbox });
    expect(autocad.calls.map(({ params, options }) => [params, options.timeoutMs])).toEqual([
      [{ documentId: ACAD_DOCUMENT_ID, maxWidth: 640, maxHeight: 480, extents: true }, READ_TIMEOUT_MS],
      [{ documentId: ACAD_DOCUMENT_ID, maxWidth: 640, maxHeight: 480, bbox }, READ_TIMEOUT_MS],
    ]);
  });
});

describe("CadService preview", () => {
  it.each([
    { app: "sketchup" as const, documentId: SKP_DOCUMENT_ID, op: "acad.erase", expected: "skp." },
    { app: "autocad" as const, documentId: ACAD_DOCUMENT_ID, op: "skp.erase", expected: "acad." },
  ])("rejects $op on a $app document without calling the host", async ({ app, documentId, op, expected }) => {
    const host = fakeCadHost(app, { preview: () => previewAnswer(documentId, [CHANGE]) });
    const { cad } = await service([host]);
    const error = await rejection(cad.preview({ documentId, operations: [{ op: `${expected}rename` }, { op }] }));
    expect(error.code).toBe("UNSUPPORTED_OPERATION");
    expect(error.message).toContain(op);
    expect(error.message).toContain(`${expected}*`);
    expect(host.calls).toEqual([]);
  });

  it("answers no proposal with a warning when nothing would change", async () => {
    const host = sketchUpHost();
    host.handlers.preview = () => previewAnswer(SKP_DOCUMENT_ID, [], ["Group 11 already has tag Walls."]);
    const { cad } = await service([host]);
    expect(await cad.preview({ documentId: SKP_DOCUMENT_ID, operations: [SET_TAG] })).toEqual({
      proposalId: null,
      documentId: SKP_DOCUMENT_ID,
      changes: [],
      warnings: ["Group 11 already has tag Walls.", "Nothing would change, so there is nothing to apply."],
      expiresAt: null,
    });
  });

  it("returns a proposal that expires 30 minutes after the preview", async () => {
    const { cad, host } = await service();
    const preview = await cad.preview({ documentId: SKP_DOCUMENT_ID, operations: [SET_TAG] });
    expect(preview).toMatchObject({ documentId: SKP_DOCUMENT_ID, changes: [CHANGE], warnings: [] });
    expect(preview.expiresAt).toBe(new Date(START + TTL_MS).toISOString());
    expect(host.calls[0]).toMatchObject({
      method: "preview",
      params: { documentId: SKP_DOCUMENT_ID, operations: [SET_TAG] },
      options: { timeoutMs: READ_TIMEOUT_MS },
    });
  });

  it("passes on the area AutoCAD says the change touches, and omits it when there is none", async () => {
    const erase = { op: "acad.erase", target: "INSERT 2A", field: "entity", before: "DOOR" };
    const bbox = { min: [0, 0], max: [10, 5] };
    const autocad = fakeCadHost("autocad", { preview: () => ({ ...previewAnswer(ACAD_DOCUMENT_ID, [erase]), bbox }) });
    const { cad } = await service([autocad]);
    const operations = [{ op: "acad.erase", handles: ["2A"] }];
    expect(await cad.preview({ documentId: ACAD_DOCUMENT_ID, operations })).toMatchObject({ changes: [erase], bbox });
    autocad.handlers.preview = () => previewAnswer(ACAD_DOCUMENT_ID, [erase]);
    expect(await cad.preview({ documentId: ACAD_DOCUMENT_ID, operations })).not.toHaveProperty("bbox");
  });

  it("issues a fresh proposalId for every preview", async () => {
    const { cad } = await service();
    expect(await propose(cad)).not.toBe(await propose(cad));
  });

  it("rejects a preview answer of the wrong shape", async () => {
    const host = sketchUpHost();
    host.handlers.preview = () => ({ documentId: SKP_DOCUMENT_ID, changes: "all of them" });
    const { cad } = await service([host]);
    expect((await rejection(cad.preview({ documentId: SKP_DOCUMENT_ID, operations: [SET_TAG] }))).code).toBe("HOST_ERROR");
  });
});

describe("CadService apply", () => {
  it("sends the proposal with its fingerprints and title, and applies at once with no dialog", async () => {
    const { cad, host } = await service();
    const proposalId = await propose(cad, [SET_TAG, { ...SET_TAG, ids: ["12"] }, { op: "skp.add_box" }]);
    const receipt = await cad.apply({ proposalId });
    const apply = host.calls.find(({ method }) => method === "apply")!;
    expect(apply.options).toMatchObject({ documentId: SKP_DOCUMENT_ID, timeoutMs: 28_000 });
    // A cancelled tool call must never cancel an edit the host may already be running.
    expect(apply.options.signal).toBeUndefined();
    expect(apply.params).toEqual({
      documentId: SKP_DOCUMENT_ID,
      operations: [SET_TAG, { ...SET_TAG, ids: ["12"] }, { op: "skp.add_box" }],
      expectedFingerprints: { [SKP_DOCUMENT_ID]: "fp-1" },
      title: "set tag, add box",
    });
    expect(receipt).toEqual({
      proposalId,
      documentId: SKP_DOCUMENT_ID,
      status: "applied",
      message: expect.stringContaining("Applied in SketchUp as one undo step"),
      changes: [CHANGE],
      created: [{ id: "99" }],
      at: new Date(START).toISOString(),
    });
  });

  it("prefers the changes the host reports applying", async () => {
    const host = sketchUpHost();
    const applied = { ...CHANGE, after: "Walls (2)" };
    host.handlers.apply = () => ({ status: "applied", changes: [applied] });
    const { cad } = await service([host]);
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    expect(receipt.changes).toEqual([applied]);
    expect(receipt.created).toEqual([]);
  });

  it("replays the first receipt instead of applying twice", async () => {
    const { cad, host } = await service();
    const proposalId = await propose(cad);
    const first = await cad.apply({ proposalId });
    const second = await cad.apply({ proposalId });
    expect(second).toEqual({ ...first, replayed: true });
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
  });

  it("refuses an unknown proposal", async () => {
    const { cad, host } = await service();
    const error = await rejection(cad.apply({ proposalId: "cadp_unknown" }));
    expect(error.code).toBe("PROPOSAL_EXPIRED");
    expect(host.calls).toEqual([]);
  });

  it("accepts a proposal until its 30 minutes run out", async () => {
    const { cad, clock } = await service();
    const proposalId = await propose(cad);
    clock.now = START + TTL_MS - 1;
    expect((await cad.apply({ proposalId })).status).toBe("applied");
  });

  it("refuses a proposal once 30 minutes have passed, and keeps refusing it", async () => {
    const { cad, clock, host } = await service();
    const proposalId = await propose(cad);
    clock.now = START + TTL_MS;
    expect((await rejection(cad.apply({ proposalId }))).code).toBe("PROPOSAL_EXPIRED");
    clock.now = START;
    expect((await rejection(cad.apply({ proposalId }))).code).toBe("PROPOSAL_EXPIRED");
    expect(host.calls.filter(({ method }) => method === "apply")).toEqual([]);
  });

  it("shares one host call between concurrent applies of the same proposal", async () => {
    const host = sketchUpHost();
    const answer = deferred<unknown>();
    host.handlers.apply = () => answer.promise;
    const { cad } = await service([host]);
    const proposalId = await propose(cad);
    const first = cad.apply({ proposalId });
    const second = cad.apply({ proposalId });
    await settle();
    answer.resolve({ status: "applied" });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.status).toBe("applied");
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
  });

  it("refuses a second change while one runs, sending nothing and keeping its proposal", async () => {
    const host = sketchUpHost();
    const answer = deferred<unknown>();
    let started = 0;
    host.handlers.apply = () => {
      started += 1;
      return started === 1 ? answer.promise : { status: "applied" };
    };
    const { cad, directory } = await service([host]);
    const firstId = await propose(cad);
    const secondId = await propose(cad);
    const first = cad.apply({ proposalId: firstId });
    // Each apply first reads the receipt log, so wait for the host call itself, not a fixed number of turns.
    await vi.waitFor(() => expect(started).toBe(1));
    // A write never waits in line: its answer must come within one call's timeout.
    expect(await rejection(cad.apply({ proposalId: secondId }))).toMatchObject({ code: "HOST_BUSY" });
    expect(started).toBe(1);
    answer.resolve({ status: "applied" });
    expect((await first).status).toBe("applied");
    expect((await cad.apply({ proposalId: secondId })).status).toBe("applied");
    expect(started).toBe(2);
    const receipts = (await readFile(join(directory, "receipts.jsonl"), "utf8")).trim().split("\n");
    expect(receipts).toHaveLength(2);
  });

  it("refuses a save copy while a change runs, and runs it afterwards", async () => {
    const host = sketchUpHost();
    const answer = deferred<unknown>();
    host.handlers.apply = () => answer.promise;
    const { cad } = await service([host]);
    const applying = cad.apply({ proposalId: await propose(cad) });
    await vi.waitFor(() => expect(host.calls.map(({ method }) => method)).toEqual(["preview", "apply"]));
    const copy = { documentId: SKP_DOCUMENT_ID, destination: join(tmpdir(), "copy.skp") };
    expect(await rejection(cad.saveCopy(copy))).toMatchObject({ code: "HOST_BUSY" });
    expect(host.calls.map(({ method }) => method)).toEqual(["preview", "apply"]);
    answer.resolve({ status: "applied" });
    await applying;
    await cad.saveCopy(copy);
    expect(host.calls.map(({ method }) => method)).toEqual(["preview", "apply", "save_copy"]);
  });

  it("keeps the queue moving after a write fails", async () => {
    const host = sketchUpHost();
    let attempt = 0;
    host.handlers.apply = () => {
      attempt += 1;
      if (attempt === 1) throw new CadError("STALE_TARGET", "Group 11 changed.");
      return { status: "applied" };
    };
    const { cad } = await service([host]);
    const firstId = await propose(cad);
    const secondId = await propose(cad);
    expect((await cad.apply({ proposalId: firstId })).status).toBe("failed");
    expect((await cad.apply({ proposalId: secondId })).status).toBe("applied");
  });

  it.each([
    { thrown: new CadError("HOST_TIMEOUT", "late"), status: "unknown", message: "may or may not have been applied" },
    { thrown: new CadError("HOST_DISCONNECTED", "gone"), status: "unknown", message: "never sent again" },
    { thrown: new CadError("APPLY_UNCONFIRMED", "no confirmation"), status: "unknown", message: "may or may not have been applied" },
    { thrown: new CadError(HOST_UNREADABLE, "garbled"), status: "unknown", message: "may or may not have been applied" },
    { thrown: new CadError("PARTIALLY_APPLIED", "2 of 3 changes applied."), status: "partial", message: "2 of 3 changes applied." },
    { thrown: new CadError("STALE_TARGET", "Group 11 changed."), status: "failed", message: "STALE_TARGET: Group 11 changed." },
    { thrown: new CadError("APPLY_FAILED", "AutoCAD refused."), status: "failed", message: "APPLY_FAILED: AutoCAD refused." },
  ])("records $thrown.code as a $status receipt", async ({ thrown, status, message }) => {
    const host = sketchUpHost();
    host.handlers.apply = () => {
      throw thrown;
    };
    const { cad } = await service([host]);
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    expect(receipt.status).toBe(status);
    expect(receipt.message).toContain(message);
    expect(receipt.changes).toEqual([CHANGE]);
    expect(await cad.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
  });

  it("records a dialog declined in an older SketchUp extension as rejected", async () => {
    const host = sketchUpHost();
    host.handlers.apply = () => ({ status: "rejected" });
    const { cad } = await service([host]);
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    expect(receipt).toMatchObject({ status: "rejected", message: expect.stringContaining("inertia_cad_setup"), created: [] });
  });

  it.each([
    { label: "an unknown status", answer: { status: "maybe" } },
    { label: "no status", answer: { changes: [] } },
    { label: "not an object", answer: "applied" },
  ])("records an apply answer with $label as unknown, since the edit may have run", async ({ answer }) => {
    const host = sketchUpHost();
    host.handlers.apply = () => answer;
    const { cad } = await service([host]);
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    expect(receipt).toMatchObject({ proposalId, status: "unknown", message: expect.stringContaining("may or may not") });
    expect(await cad.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
  });

  it("records a host crash that is not a CadError as unknown", async () => {
    const host = sketchUpHost();
    host.handlers.apply = () => {
      throw new RangeError("bridge bug");
    };
    const { cad } = await service([host]);
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    expect(receipt).toMatchObject({ proposalId, status: "unknown", changes: [CHANGE] });
    expect(await cad.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
  });

  it("records an older SketchUp extension's unanswered dialog as expired", async () => {
    const host = sketchUpHost();
    host.handlers.apply = () => ({ status: "expired" });
    const { cad, directory } = await service([host]);
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    expect(receipt).toMatchObject({ proposalId, status: "expired", message: expect.stringContaining("Nothing was modified"), created: [] });
    const lines = (await readFile(join(directory, "receipts.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([receipt]);
    expect(await cad.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
  });
});

const NOT_SENT_CODES = [
  "HOST_BUSY",
  "HOST_OFFLINE",
  "HOST_UNAVAILABLE",
  "UNDO_DISABLED",
  "TIME_BUDGET",
  "INACTIVE_DOCUMENT",
  "DOCUMENT_NOT_FOUND",
  "NOT_INSTALLED",
  "UNSUPPORTED_PLATFORM",
  "SETUP_FAILED",
  "UNAUTHORIZED",
  "CANCELLED",
];

describe("CadService apply refused before any step", () => {
  it.each(NOT_SENT_CODES)("rejects %s, writes no receipt, and lets the same proposal be applied again", async (code) => {
    const host = sketchUpHost();
    let attempts = 0;
    host.handlers.apply = () => {
      attempts += 1;
      if (attempts === 1) throw new CadError(code, `${code} detail`);
      return { status: "applied" };
    };
    const { cad, directory } = await service([host]);
    const proposalId = await propose(cad);
    expect(await rejection(cad.apply({ proposalId }))).toMatchObject({ code, message: `${code} detail` });
    const file = join(directory, "receipts.jsonl");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = await cad.apply({ proposalId });
    expect(receipt).toMatchObject({ proposalId, status: "applied" });
    expect(receipt).not.toHaveProperty("replayed");
    expect(attempts).toBe(2);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([receipt]);
  });

  it("rejects every concurrent apply of the proposal with the same failure", async () => {
    const host = sketchUpHost();
    const answer = deferred<unknown>();
    host.handlers.apply = () => answer.promise;
    const { cad } = await service([host]);
    const proposalId = await propose(cad);
    const first = rejection(cad.apply({ proposalId }));
    const second = rejection(cad.apply({ proposalId }));
    await vi.waitFor(() => expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1));
    answer.reject(new CadError("HOST_BUSY", "Close the dialog."));
    expect((await first).code).toBe("HOST_BUSY");
    expect((await second).code).toBe("HOST_BUSY");
    host.handlers.apply = () => ({ status: "applied" });
    expect((await cad.apply({ proposalId })).status).toBe("applied");
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(2);
  });

  it("does not put back a proposal that expired while it waited", async () => {
    const host = sketchUpHost();
    const { cad, clock } = await service([host]);
    host.handlers.apply = () => {
      clock.now = START + TTL_MS;
      throw new CadError("HOST_BUSY", "Close the dialog.");
    };
    const proposalId = await propose(cad);
    expect((await rejection(cad.apply({ proposalId }))).code).toBe("HOST_BUSY");
    expect((await rejection(cad.apply({ proposalId }))).code).toBe("PROPOSAL_EXPIRED");
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
  });
});

describe("CadService receipts", () => {
  it("appends each outcome to receipts.jsonl", async () => {
    const { cad, directory } = await service();
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    const lines = (await readFile(join(directory, "receipts.jsonl"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([receipt]);
  });

  it("answers a retried apply after a restart from the receipt file", async () => {
    const { cad, directory } = await service();
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    const restartedHost = sketchUpHost();
    const restarted = new CadService({ hosts: [restartedHost], stateDirectory: directory, now: () => START });
    expect(await restarted.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
    expect(restartedHost.calls).toEqual([]);
  });

  it("skips unreadable and unrelated lines in the receipt file", async () => {
    const { cad, directory } = await service();
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    const file = join(directory, "receipts.jsonl");
    const saved = await readFile(file, "utf8");
    await writeFile(file, `${saved}{"proposalId":"${proposalId}", broken\n{"proposalId":"${proposalId}x","status":"applied"}\n`);
    const restarted = new CadService({ hosts: [sketchUpHost()], stateDirectory: directory });
    expect(await restarted.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
  });

  it("keeps the outcome when the receipt file cannot be written", async () => {
    const parent = await stateDirectory();
    const blocked = join(parent, "not-a-directory");
    await writeFile(blocked, "a file where the state directory should be");
    const host = sketchUpHost();
    const cad = new CadService({ hosts: [host], stateDirectory: blocked, now: () => START });
    const proposalId = await propose(cad);
    const receipt = await cad.apply({ proposalId });
    expect(receipt.status).toBe("applied");
    expect(await cad.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
  });

  it("keeps only the newest 5000 lines of a long receipt file, with their outcomes", async () => {
    const directory = await stateDirectory();
    const file = join(directory, "receipts.jsonl");
    const statuses = ["applied", "rejected", "expired", "failed", "unknown", "partial"] as const;
    const stored = Array.from({ length: 5003 }, (_, index) => ({
      proposalId: `cadp_old${index}`,
      documentId: SKP_DOCUMENT_ID,
      status: statuses[index % statuses.length]!,
      message: `outcome ${index}`,
      changes: [CHANGE],
      created: [],
      at: new Date(START).toISOString(),
    }));
    await writeFile(file, `${stored.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`);
    const host = sketchUpHost();
    const cad = new CadService({ hosts: [host], stateDirectory: directory, now: () => START });
    expect(await cad.apply({ proposalId: "cadp_old5002" })).toEqual({ ...stored[5002], replayed: true });
    expect(await cad.apply({ proposalId: "cadp_old3" })).toEqual({ ...stored[3], replayed: true });
    expect((await rejection(cad.apply({ proposalId: "cadp_old2" }))).code).toBe("PROPOSAL_EXPIRED");
    const kept = (await readFile(file, "utf8")).trim().split("\n");
    expect(kept.map((line) => JSON.parse(line) as unknown)).toEqual(stored.slice(3));
    // New outcomes append to the trimmed file; the next start trims it to 5000 again.
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(5001);
    const restarted = new CadService({ hosts: [sketchUpHost()], stateDirectory: directory, now: () => START });
    for (const index of [4, 5, 6, 7, 8, 9]) {
      expect(await restarted.apply({ proposalId: `cadp_old${index}` })).toEqual({ ...stored[index], replayed: true });
    }
    expect(await restarted.apply({ proposalId: receipt.proposalId })).toEqual({ ...receipt, replayed: true });
    expect((await rejection(restarted.apply({ proposalId: "cadp_old3" }))).code).toBe("PROPOSAL_EXPIRED");
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(5000);
    expect(host.calls.filter(({ method }) => method === "apply")).toHaveLength(1);
  });

  it("leaves a receipt file of exactly 5000 lines as it is", async () => {
    const { cad, directory } = await service();
    const file = join(directory, "receipts.jsonl");
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    const line = JSON.stringify(receipt);
    const text = Array.from({ length: 5000 }, (_, index) => line.replace(receipt.proposalId, `cadp_n${index}`)).join("\n");
    await writeFile(file, `${text}\n`);
    const restarted = new CadService({ hosts: [sketchUpHost()], stateDirectory: directory, now: () => START });
    expect(await restarted.apply({ proposalId: "cadp_n0" })).toMatchObject({ proposalId: "cadp_n0", replayed: true });
    expect(await readFile(file, "utf8")).toBe(`${text}\n`);
  });

  it("reads receipts.jsonl once per service instance", async () => {
    const { cad, directory } = await service();
    const file = join(directory, "receipts.jsonl");
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    await appendFile(file, `${JSON.stringify({ ...receipt, proposalId: "cadp_external" })}\n`);
    expect((await rejection(cad.apply({ proposalId: "cadp_external" }))).code).toBe("PROPOSAL_EXPIRED");
    const restarted = new CadService({ hosts: [sketchUpHost()], stateDirectory: directory, now: () => START });
    expect(await restarted.apply({ proposalId: "cadp_external" })).toEqual({ ...receipt, proposalId: "cadp_external", replayed: true });
  });
});

describe("CadService save copy", () => {
  it("defaults to a dated copy next to the document", async () => {
    const folder = await stateDirectory();
    const host = sketchUpHost();
    host.documents = [cadDocument("sketchup", { path: join(folder, "House.skp") })];
    const { cad } = await service([host]);
    expect(await cad.saveDestination({ documentId: SKP_DOCUMENT_ID })).toBe(copyName(join(folder, "House.skp"), START));
  });

  it("requires a destination for a document that has no file", async () => {
    const { cad } = await service();
    const error = await rejection(cad.saveDestination({ documentId: SKP_DOCUMENT_ID }));
    expect(error.code).toBe("DESTINATION_REQUIRED");
    expect(error.message).toContain(".skp");
  });

  it("requires a destination for a document the host no longer lists", async () => {
    const host = sketchUpHost();
    host.documents = [];
    const { cad } = await service([host]);
    expect((await rejection(cad.saveDestination({ documentId: SKP_DOCUMENT_ID }))).code).toBe("DESTINATION_REQUIRED");
  });

  it("accepts an absolute destination with the app's extension in any case", async () => {
    const destination = join(tmpdir(), "Copy.SKP");
    const { cad } = await service();
    expect(await cad.saveDestination({ documentId: SKP_DOCUMENT_ID, destination })).toBe(destination);
  });

  it.each([
    { label: "a relative path", destination: join("models", "Copy.skp") },
    { label: "the other app's extension", destination: join(tmpdir(), "Copy.dwg") },
    { label: "no extension", destination: join(tmpdir(), "Copy") },
  ])("refuses $label", async ({ destination }) => {
    const { cad } = await service();
    const error = await rejection(cad.saveDestination({ documentId: SKP_DOCUMENT_ID, destination }));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain(".skp");
  });

  it("requires .dwg for an AutoCAD drawing", async () => {
    const host = fakeCadHost("autocad");
    const { cad } = await service([host]);
    const error = await rejection(cad.saveDestination({ documentId: ACAD_DOCUMENT_ID, destination: join(tmpdir(), "a.skp") }));
    expect(error.message).toContain(".dwg");
    expect(await cad.saveDestination({ documentId: ACAD_DOCUMENT_ID, destination: join(tmpdir(), "a.dwg") }))
      .toBe(join(tmpdir(), "a.dwg"));
  });

  it("checks an agent-supplied destination as a local Windows path on Windows", async () => {
    const directory = await stateDirectory();
    const cad = new CadService({ hosts: [fakeCadHost("autocad")], stateDirectory: directory, platform: "win32" });
    expect(await cad.saveDestination({ documentId: ACAD_DOCUMENT_ID, destination: "C:/Projects/old/../Plan copy.dwg" }))
      .toBe("C:\\Projects\\Plan copy.dwg");
    for (const destination of ["\\\\server\\share\\a.dwg", "\\\\?\\C:\\a.dwg", "C:\\Projects\\Plan:hidden.dwg", "Projects\\a.dwg"]) {
      const error = await rejection(cad.saveDestination({ documentId: ACAD_DOCUMENT_ID, destination }));
      expect(error.code, destination).toBe("INVALID_REQUEST");
      expect(error.message).toContain("local drive");
    }
  });

  it("checks the default copy path of an AutoCAD drawing as a local Windows path before it is offered", async () => {
    const directory = await stateDirectory();
    const host = fakeCadHost("autocad");
    const cad = new CadService({ hosts: [host], stateDirectory: directory, platform: "win32", now: () => START });
    host.documents = [cadDocument("autocad", { path: "C:\\Projects\\Plan.dwg" })];
    expect(await cad.saveDestination({ documentId: ACAD_DOCUMENT_ID })).toBe(copyName("C:\\Projects\\Plan.dwg", START));
    host.documents = [cadDocument("autocad", { path: "\\\\server\\share\\Plan.dwg" })];
    const error = await rejection(cad.saveDestination({ documentId: ACAD_DOCUMENT_ID }));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("local drive");
    expect(await cad.saveDestination({ documentId: ACAD_DOCUMENT_ID, destination: "C:\\Projects\\Plan copy.dwg" }))
      .toBe("C:\\Projects\\Plan copy.dwg");
    expect(host.calls.map(({ method }) => method)).not.toContain("save_copy");
  });

  it("sends save_copy with the destination as path", async () => {
    const destination = join(tmpdir(), "Copy.skp");
    const { cad, host } = await service();
    expect(await cad.saveCopy({ documentId: SKP_DOCUMENT_ID, destination })).toEqual({ saved: destination });
    expect(host.calls[0]).toMatchObject({
      method: "save_copy",
      params: { documentId: SKP_DOCUMENT_ID, path: destination },
      options: { documentId: SKP_DOCUMENT_ID, timeoutMs: 120_000 },
    });
  });
});

describe("checkDestination", () => {
  function refusal(destination: string, platform: NodeJS.Platform, extension: string): CadError {
    let caught: unknown;
    try {
      checkDestination(destination, platform, extension);
    } catch (error) {
      caught = error;
    }
    expect(caught, destination).toBeInstanceOf(CadError);
    return caught as CadError;
  }

  it("accepts a local drive path on Windows and returns it normalized", () => {
    expect(checkDestination("C:\\Projects\\Plan copy.dwg", "win32", ".dwg")).toBe("C:\\Projects\\Plan copy.dwg");
    expect(checkDestination("C:\\Projects\\Console room.dwg", "win32", ".dwg")).toBe("C:\\Projects\\Console room.dwg");
    expect(checkDestination("d:/Models/x/../House.SKP", "win32", ".skp")).toBe("d:\\Models\\House.SKP");
  });

  it.each([
    { label: "a UNC share", destination: "\\\\server\\share\\a.dwg" },
    { label: "a forward-slash UNC share", destination: "//server/share/a.dwg" },
    { label: "a \\\\?\\ path", destination: "\\\\?\\C:\\a.dwg" },
    { label: "a \\\\.\\ device path", destination: "\\\\.\\C:\\a.dwg" },
    { label: "an alternate data stream after the name", destination: "C:\\a.dwg:evil" },
    { label: "an alternate data stream named like a drawing", destination: "C:\\Projects\\Plan:evil.dwg" },
    { label: "a drive-relative path", destination: "C:a.dwg" },
    { label: "a path rooted on the current drive", destination: "\\Projects\\a.dwg" },
    { label: "a relative path", destination: "Projects\\a.dwg" },
    { label: "the wrong extension", destination: "C:\\Projects\\a.skp" },
    { label: "no extension", destination: "C:\\Projects\\a" },
    { label: "the NUL device name", destination: "C:\\Projects\\NUL.dwg" },
    { label: "the CON device name in lower case", destination: "C:\\Projects\\con.dwg" },
    { label: "a COM port name", destination: "C:\\COM1.dwg" },
    { label: "a printer port name with trailing spaces", destination: "C:\\Projects\\LPT1 .dwg" },
    { label: "a device name before a second extension", destination: "C:\\Projects\\aux.copy.dwg" },
  ])("refuses $label on Windows", ({ destination }) => {
    const error = refusal(destination, "win32", ".dwg");
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toContain("C:\\Projects\\Plan copy.dwg");
  });

  it("accepts an absolute path elsewhere and refuses a relative one or the wrong extension", () => {
    expect(checkDestination("/Users/x/a.skp", "darwin", ".skp")).toBe("/Users/x/a.skp");
    expect(checkDestination("/Users/x/../x/b.SKP", "linux", ".skp")).toBe("/Users/x/b.SKP");
    for (const destination of ["Users/x/a.skp", "./a.skp", "a.skp", "/Users/x/a.dwg", "/Users/x/a"]) {
      const error = refusal(destination, "darwin", ".skp");
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toContain("absolute path ending in .skp");
    }
  });
});

describe("copyName", () => {
  it("adds a local-time stamp before the extension in the same folder", () => {
    const folder = join(tmpdir(), "drawings");
    const at = new Date(2026, 10, 21, 16, 5, 59).getTime();
    expect(copyName(join(folder, "Plan.dwg"), at)).toBe(join(folder, "Plan (Inertia copy 2026-11-21 160559).dwg"));
  });

  it("pads single-digit months, days, hours, minutes and seconds", () => {
    const at = new Date(2027, 0, 2, 3, 4, 5).getTime();
    expect(copyName(join(tmpdir(), "House.v2.skp"), at)).toBe(join(tmpdir(), "House.v2 (Inertia copy 2027-01-02 030405).skp"));
  });

  it("gives copies saved a few seconds apart different names", () => {
    const at = new Date(2026, 10, 21, 16, 5, 1).getTime();
    expect(copyName(join(tmpdir(), "Plan.dwg"), at)).not.toBe(copyName(join(tmpdir(), "Plan.dwg"), at + 1_000));
  });
});
