import { pathToFileURL } from "node:url";

const workerPath = process.env.INERTIA_RECOVERY_TEST_WORKER;
if (!workerPath || typeof process.send !== "function") {
  throw new Error("The runtime worker Node host needs an IPC channel and worker path.");
}

Object.defineProperty(process, "parentPort", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: {
    on(event, listener) {
      if (event !== "message") return;
      process.on("message", (data) => listener({ data }));
    },
    postMessage(message) {
      process.send(message);
    },
  },
});

await import(pathToFileURL(workerPath).href);
