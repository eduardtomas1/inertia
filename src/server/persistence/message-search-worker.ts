import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { searchMessages } from "./message-search";

const input = workerData as { databasePath: string; query: string };
let database: Database.Database | null = null;
try {
  database = new Database(input.databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
  database.pragma("query_only = ON");
  const result = searchMessages(database, input.query);
  database.close();
  database = null;
  parentPort?.postMessage(result);
} finally {
  database?.close();
}
