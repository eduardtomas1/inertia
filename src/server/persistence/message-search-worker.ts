import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type { MessageSearchContinuation } from "../../shared/message-search";
import { searchMessages } from "./message-search";

const input = workerData as { databasePath: string; query: string; continuation: MessageSearchContinuation | null };
let database: Database.Database | null = null;
try {
  database = new Database(input.databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  database.pragma("query_only = ON");
  database.pragma("mmap_size = 0");
  const result = searchMessages(database, input.query, { continuation: input.continuation });
  database.close();
  database = null;
  parentPort?.postMessage(result);
} finally {
  database?.close();
}
