// @inertia-test-suite portable
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CadError } from "../../src/server/cad/cad-hosts";
import {
  approvalMessage,
  type CadChange,
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
    capture: () => ({ documentId: SKP_DOCUMENT_ID, width: 10, height: 8, pngBase64: "AAAA", scene: null }),
    save_copy: (params) => ({ saved: params.path }),
  });
}

async function service(hosts = [sketchUpHost()], clock = { now: START }) {
  const directory = await stateDirectory();
  const cad = new CadService({ hosts, stateDirectory: directory, now: () => clock.now });
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

  it("forwards selection and query to the owning host with the read timeout", async () => {
    const { cad, host } = await service();
    expect(await cad.selection({ documentId: SKP_DOCUMENT_ID, limit: 5 })).toEqual({ items: [{ id: "11" }] });
    expect(await cad.query({ documentId: SKP_DOCUMENT_ID, tag: "Walls" })).toEqual({ items: [], nextCursor: null });
    expect(host.calls.map(({ method, params, options }) => [method, params, options.documentId, options.timeoutMs]))
      .toEqual([
        ["selection", { documentId: SKP_DOCUMENT_ID, limit: 5 }, SKP_DOCUMENT_ID, 60_000],
        ["query", { documentId: SKP_DOCUMENT_ID, tag: "Walls" }, SKP_DOCUMENT_ID, 60_000],
      ]);
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
      options: { timeoutMs: 60_000 },
    });
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
  it("sends the proposal with its fingerprints, approval text and title", async () => {
    const { cad, host } = await service();
    const proposalId = await propose(cad, [SET_TAG, { ...SET_TAG, ids: ["12"] }, { op: "skp.add_box" }]);
    const receipt = await cad.apply({ proposalId });
    const apply = host.calls.find(({ method }) => method === "apply")!;
    expect(apply.options).toMatchObject({ documentId: SKP_DOCUMENT_ID, timeoutMs: 10 * 60 * 1000 });
    expect(apply.params).toEqual({
      documentId: SKP_DOCUMENT_ID,
      operations: [SET_TAG, { ...SET_TAG, ids: ["12"] }, { op: "skp.add_box" }],
      expectedFingerprints: { [SKP_DOCUMENT_ID]: "fp-1" },
      approvalMessage: approvalMessage(SKP_DOCUMENT_ID, [CHANGE]),
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

  it("labels the approval with the document name the host reports", async () => {
    const host = fakeCadHost("autocad", {
      preview: () => ({ ...previewAnswer(ACAD_DOCUMENT_ID, [CHANGE]), documentName: "Site plan.dwg" }),
      apply: () => ({ status: "applied" }),
    });
    const { cad } = await service([host]);
    const preview = await cad.preview({ documentId: ACAD_DOCUMENT_ID, operations: [{ op: "acad.erase" }] });
    await cad.apply({ proposalId: preview.proposalId! });
    expect(host.calls[1]!.params.approvalMessage).toContain("wants to change Site plan.dwg:");
  });

  it("falls back to the drawing's file name in the approval text", async () => {
    const host = fakeCadHost("autocad", {
      preview: () => previewAnswer(ACAD_DOCUMENT_ID, [CHANGE]),
      apply: () => ({ status: "applied" }),
    });
    const { cad } = await service([host]);
    const preview = await cad.preview({ documentId: ACAD_DOCUMENT_ID, operations: [{ op: "acad.erase" }] });
    await cad.apply({ proposalId: preview.proposalId! });
    expect(host.calls[1]!.params.approvalMessage).toContain("wants to change Plan.dwg:");
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

  it("runs writes one at a time", async () => {
    const host = sketchUpHost();
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let started = 0;
    host.handlers.apply = () => answers[started++]!.promise;
    const { cad } = await service([host]);
    const firstId = await propose(cad);
    const secondId = await propose(cad);
    const first = cad.apply({ proposalId: firstId });
    await settle();
    const second = cad.apply({ proposalId: secondId });
    await settle();
    expect(started).toBe(1);
    answers[0]!.resolve({ status: "applied" });
    expect((await first).status).toBe("applied");
    await settle();
    expect(started).toBe(2);
    answers[1]!.resolve({ status: "rejected" });
    expect((await second).status).toBe("rejected");
  });

  it("starts a save copy only after a running apply finishes", async () => {
    const host = sketchUpHost();
    const answer = deferred<unknown>();
    host.handlers.apply = () => answer.promise;
    const { cad } = await service([host]);
    const applying = cad.apply({ proposalId: await propose(cad) });
    await settle();
    const saving = cad.saveCopy({ documentId: SKP_DOCUMENT_ID, destination: join(tmpdir(), "copy.skp") });
    await settle();
    expect(host.calls.map(({ method }) => method)).toEqual(["preview", "apply"]);
    answer.resolve({ status: "applied" });
    await applying;
    await saving;
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
    { thrown: new CadError("PARTIALLY_APPLIED", "2 of 3 changes applied."), status: "partial", message: "2 of 3 changes applied." },
    { thrown: new CadError("STALE_TARGET", "Group 11 changed."), status: "failed", message: "STALE_TARGET: Group 11 changed." },
    { thrown: new CadError("HOST_OFFLINE", "SketchUp is closed."), status: "failed", message: "HOST_OFFLINE: SketchUp is closed." },
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

  it("records a declined dialog as rejected", async () => {
    const host = sketchUpHost();
    host.handlers.apply = () => ({ status: "rejected" });
    const { cad } = await service([host]);
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    expect(receipt).toMatchObject({ status: "rejected", message: expect.stringContaining("declined"), created: [] });
  });

  it("records an apply answer of the wrong shape as failed", async () => {
    const host = sketchUpHost();
    host.handlers.apply = () => ({ status: "maybe" });
    const { cad } = await service([host]);
    const receipt = await cad.apply({ proposalId: await propose(cad) });
    expect(receipt.status).toBe("failed");
    expect(receipt.message).toMatch(/^HOST_ERROR: /u);
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

describe("approvalMessage", () => {
  it("shows each change as before → after", () => {
    expect(approvalMessage("House.skp", [CHANGE])).toBe(
      "An agent in Inertia wants to change House.skp:\n\n"
      + "• Group 11: tag Untagged → Walls"
      + "\n\nApply these changes? You can undo them in one step.",
    );
  });

  it("shows only the new value for a created object", () => {
    const message = approvalMessage("Plan.dwg", [
      { op: "acad.add_line", target: "New line", field: "geometry", after: { start: [0, 0], end: [1, 1] } },
      { op: "acad.create_layer", target: "Layer Doors", field: "name", before: null, after: "Doors" },
    ]);
    expect(message).toContain("• New line: {\"start\":[0,0],\"end\":[1,1]}\n");
    expect(message).toContain("• Layer Doors: Doors\n");
  });

  it("writes none for an empty value and shortens long values", () => {
    const message = approvalMessage("Plan.dwg", [
      { op: "acad.set_text", target: "Text 2A", field: "text", before: "Old", after: "" },
      { op: "acad.set_text", target: "Text 2B", field: "text", before: "x".repeat(100), after: "y" },
    ]);
    expect(message).toContain("• Text 2A: text Old → none");
    expect(message).toContain(`• Text 2B: text ${"x".repeat(57)}... → y`);
  });

  it("caps a line at 160 characters", () => {
    const message = approvalMessage("Plan.dwg", [{ op: "acad.set_text", target: "T".repeat(200), field: "text", after: "a" }]);
    const line = message.split("\n").find((candidate) => candidate.startsWith("• "))!;
    expect(line).toHaveLength(160);
    expect(line.endsWith("...")).toBe(true);
  });

  it("lists 18 changes and counts the rest", () => {
    const changes = Array.from({ length: 21 }, (_, index) => ({ ...CHANGE, target: `Group ${index}` }));
    const message = approvalMessage("House.skp", changes);
    expect(message.split("\n").filter((line) => line.startsWith("• "))).toHaveLength(18);
    expect(message).toContain("• Group 17:");
    expect(message).not.toContain("• Group 18:");
    expect(message).toContain("\n…and 3 more change(s).\n");
  });

  it("does not count extra changes at exactly 18", () => {
    const changes = Array.from({ length: 18 }, (_, index) => ({ ...CHANGE, target: `Group ${index}` }));
    expect(approvalMessage("House.skp", changes)).not.toContain("more change");
  });
});

describe("copyName", () => {
  it("adds a local-time stamp before the extension in the same folder", () => {
    const folder = join(tmpdir(), "drawings");
    const at = new Date(2026, 10, 21, 16, 5, 59).getTime();
    expect(copyName(join(folder, "Plan.dwg"), at)).toBe(join(folder, "Plan (Inertia copy 2026-11-21 1605).dwg"));
  });

  it("pads single-digit months, days, hours and minutes", () => {
    const at = new Date(2027, 0, 2, 3, 4).getTime();
    expect(copyName(join(tmpdir(), "House.v2.skp"), at)).toBe(join(tmpdir(), "House.v2 (Inertia copy 2027-01-02 0304).skp"));
  });
});
