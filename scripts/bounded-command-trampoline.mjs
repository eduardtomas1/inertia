import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

const maximumPayloadBytes = 128 * 1024;

function writeDiagnostic(value) {
  const buffer = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(2, buffer, offset, buffer.length - offset);
    if (written <= 0)
      throw new Error("The bounded command settlement marker failed.");
    offset += written;
  }
}

function decodedPayload(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > Math.ceil(maximumPayloadBytes / 3) * 4 ||
    !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new Error("The bounded command payload is invalid.");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length > maximumPayloadBytes ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("The bounded command payload is invalid.");
  }
  const payload = JSON.parse(bytes.toString("utf8"));
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.command !== "string" ||
    payload.command.length < 1 ||
    !Array.isArray(payload.args) ||
    payload.args.some((argument) => typeof argument !== "string") ||
    (payload.input !== null && typeof payload.input !== "string") ||
    (payload.holdAuthority !== undefined &&
      typeof payload.holdAuthority !== "boolean") ||
    (payload.windowsVerbatimArguments !== undefined &&
      typeof payload.windowsVerbatimArguments !== "boolean") ||
    (payload.settlementToken !== undefined &&
      (typeof payload.settlementToken !== "string" ||
        !/^[0-9a-f-]{36}$/u.test(payload.settlementToken)))
  )
    throw new Error("The bounded command payload is invalid.");
  return payload;
}

const payload = decodedPayload(process.argv[2]);
const reader = createInterface({ input: process.stdin });
const admission = await new Promise((resolveAdmission) => {
  reader.once("line", resolveAdmission);
  reader.once("close", () => resolveAdmission(null));
});
if (admission !== "GO") process.exit(125);
reader.close();

const child = spawn(payload.command, payload.args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: [payload.input === null ? "ignore" : "pipe", "inherit", "inherit"],
  windowsVerbatimArguments: payload.windowsVerbatimArguments === true,
  windowsHide: true,
});
let childSettled = false;
const closeOwnedChild = () => {
  if (childSettled) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Child completion below reports whether the exact handle settled.
  }
};
if (payload.holdAuthority === true) {
  process.stdin.once("end", closeOwnedChild);
  process.stdin.once("close", closeOwnedChild);
  process.stdin.once("error", closeOwnedChild);
  process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed) closeOwnedChild();
}
if (payload.input !== null)
  child.stdin?.end(Buffer.from(payload.input, "base64"));
const result = await new Promise((resolveResult) => {
  child.once("error", (error) => resolveResult({ error }));
  child.once("close", (code, signal) => resolveResult({ code, signal }));
});
childSettled = true;
process.stdin.off("end", closeOwnedChild);
process.stdin.off("close", closeOwnedChild);
process.stdin.off("error", closeOwnedChild);
if (payload.settlementToken !== undefined) {
  writeDiagnostic(`INERTIA_SETTLED:${payload.settlementToken}\n`);
}
if (result.error) throw result.error;
if (result.signal !== null) process.exit(1);
process.exit(result.code ?? 1);
