import type {
  CadApp,
  CadBridgeMethod,
  CadCallOptions,
  CadDocument,
  CadHost,
  CadHostStatus,
  CadSetupResult,
} from "../../src/server/cad/cad-hosts";

export type FakeHandler = (params: Record<string, unknown>, options: CadCallOptions) => unknown;

export interface FakeHostCall {
  method: CadBridgeMethod;
  params: Record<string, unknown>;
  options: CadCallOptions;
}

export interface FakeCadHost extends CadHost {
  readonly calls: FakeHostCall[];
  readonly statusCalls: number;
  readonly setupCalls: number;
  documents: CadDocument[];
  handlers: Partial<Record<CadBridgeMethod, FakeHandler>>;
  plan: string[] | undefined;
}

export const ACAD_DOCUMENT_ID = "acad:/drawings/Plan.dwg";
export const SKP_DOCUMENT_ID = "skp:4242:1";

export function cadDocument(app: CadApp, overrides: Partial<CadDocument> = {}): CadDocument {
  return {
    documentId: app === "autocad" ? ACAD_DOCUMENT_ID : SKP_DOCUMENT_ID,
    app,
    name: app === "autocad" ? "Plan.dwg" : "House.skp",
    path: null,
    modified: false,
    active: true,
    ...overrides,
  };
}

/** A CadHost whose bridge answers come from `handlers`; it records every call it receives. */
export function fakeCadHost(
  app: CadApp,
  handlers: Partial<Record<CadBridgeMethod, FakeHandler>> = {},
  documents: CadDocument[] = [cadDocument(app)],
): FakeCadHost {
  const prefix = app === "autocad" ? "acad:" : "skp:";
  let statusCalls = 0;
  let setupCalls = 0;
  const host: FakeCadHost = {
    app,
    calls: [],
    get statusCalls() {
      return statusCalls;
    },
    get setupCalls() {
      return setupCalls;
    },
    documents,
    handlers,
    plan: undefined,
    owns: (documentId) => documentId.startsWith(prefix),
    status: async (): Promise<CadHostStatus> => {
      statusCalls += 1;
      return { app, state: "connected", bridgeVersion: "1.0.0", documents: host.documents };
    },
    call: async (method, params, options) => {
      host.calls.push({ method, params, options });
      const handler = host.handlers[method];
      if (handler === undefined) throw new Error(`The fake ${app} host has no ${method} handler.`);
      return await handler(params, options);
    },
    setupPlan: async () => host.plan,
    setup: async (): Promise<CadSetupResult> => {
      setupCalls += 1;
      return { app, installedFor: [`${app} test`], restartRequired: false, note: `${app} ready` };
    },
  };
  return host;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks and short I/O run. */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function previewAnswer(
  documentId: string,
  changes: Array<{ op: string; target: string; field: string; before?: unknown; after?: unknown }>,
  warnings: string[] = [],
): Record<string, unknown> {
  return { documentId, changes, fingerprints: { [documentId]: "fp-1" }, warnings };
}
