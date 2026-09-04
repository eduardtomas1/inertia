import { runAcpInitializeHandshake } from "./provider-drift-process.mjs";

const MAX_PAYLOAD_BYTES = 64 * 1024;

function parsePayload(encoded) {
  if (typeof encoded !== "string" || encoded.length < 1
    || encoded.length > Math.ceil(MAX_PAYLOAD_BYTES / 3) * 4
    || !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error("ACP runtime probe payload is invalid.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_PAYLOAD_BYTES || bytes.toString("base64") !== encoded) {
    throw new Error("ACP runtime probe payload is invalid.");
  }
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object"
    || typeof value.command !== "string" || value.command.length < 1
    || !Array.isArray(value.args)
    || value.args.some((argument) => typeof argument !== "string")
    || !value.validation || typeof value.validation !== "object"
    || typeof value.validation.expectedAgent !== "string"
    || value.validation.expectedAgent.length < 1
    || typeof value.validation.requireLoadSession !== "boolean"
    || (value.validation.allowMissingAgentInfo !== undefined
      && typeof value.validation.allowMissingAgentInfo !== "boolean")
    || (value.validation.advertiseCompaction !== undefined
      && typeof value.validation.advertiseCompaction !== "boolean")
    || (value.validation.allowSessionCapabilitiesResume !== undefined
      && typeof value.validation.allowSessionCapabilitiesResume !== "boolean")) {
    throw new Error("ACP runtime probe payload is invalid.");
  }
  return value;
}

const payload = parsePayload(process.argv[2]);
await runAcpInitializeHandshake(
  payload.command,
  payload.args,
  { cwd: process.cwd(), environment: process.env },
  payload.validation,
);
