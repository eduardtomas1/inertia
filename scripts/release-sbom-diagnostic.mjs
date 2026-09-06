const ERROR_CODES = new Set([
  "ETIMEDOUT", "ENOBUFS", "ENOENT", "EACCES", "EPERM", "EAGAIN",
  "ENOMEM", "EMFILE", "ENFILE", "EINVAL", "ENOEXEC", "E2BIG", "EIO",
]);
const SIGNALS = new Set([
  "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGILL", "SIGBUS",
  "SIGFPE", "SIGINT", "SIGHUP", "SIGQUIT", "SIGPIPE", "SIGTRAP",
  "SIGXCPU", "SIGXFSZ", "SIGSYS", "SIGBREAK",
]);

function outputBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return Buffer.isBuffer(value) ? value.byteLength : null;
}

export function releaseSbomFailureMessage(result, elapsedMs) {
  // Child output and error messages may contain credentials or npm config.
  // Retain only counts, numeric status, and explicitly known system tokens.
  const diagnostic = {
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs) : "UNKNOWN",
    status: Number.isSafeInteger(result.status) ? result.status
      : result.status == null ? null : "UNKNOWN",
    signal: result.signal == null ? null
      : SIGNALS.has(result.signal) ? result.signal : "UNKNOWN",
    errorCode: result.error == null ? null
      : ERROR_CODES.has(result.error.code) ? result.error.code : "UNKNOWN",
    stdoutBytes: outputBytes(result.stdout),
    stderrBytes: outputBytes(result.stderr),
  };
  return `The release dependency SBOM could not be generated. ${JSON.stringify(diagnostic)}`;
}
