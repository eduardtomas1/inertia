import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { indexMessageSearchBatch } from "./message-search-indexer";
import {
  messageSearchIndexWorkerRequestSchema,
  type MessageSearchIndexWorkerResponse,
} from "./message-search-index-worker-protocol";
import { applyRuntimeConnectionPragmas } from "./runtime-connection-pragmas";

const port = parentPort;
if (!port) throw new Error("The message search index worker has no owner.");
const { databasePath } = workerData as { databasePath: string };
const database = new Database(databasePath, { fileMustExist: true, timeout: 5_000 });
applyRuntimeConnectionPragmas(database);

port.on("message", (value: unknown) => {
  const request = messageSearchIndexWorkerRequestSchema.safeParse(value);
  if (!request.success) return;
  if (request.data.type === "close") {
    database.close();
    port.close();
    return;
  }
  let response: MessageSearchIndexWorkerResponse;
  try {
    response = { id: request.data.id, progress: indexMessageSearchBatch(database, request.data) };
  } catch {
    response = { id: request.data.id, failed: true };
  }
  port.postMessage(response);
});
