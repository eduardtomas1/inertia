import { REPORT_TEXT_LIMIT } from "./issue-report";

const SENSITIVE_REPORT_KEY = /^(?:api[_ -]?(?:key|token)|(?:access|refresh)[_ -]?token|client[_ -]?secret|password|authorization|cookies?|credentials?|secret[_ -]?(?:access[_ -]?)?key|secrets?|tokens?)$/iu;

/** Decode only short JSON field names, never arbitrary prose or field values. */
function exposeSensitiveJsonKeys(text: string): string {
  return text.replace(/"(?:\\.|[^"\\\r\n]){1,128}"(?=\s*:)/gu, (literal) => {
    try {
      const key: unknown = JSON.parse(literal);
      return typeof key === "string" && SENSITIVE_REPORT_KEY.test(key)
        ? JSON.stringify(key.toLowerCase()) : literal;
    } catch { return literal; }
  });
}

const SECRET_NAME_PART = /^(?:[A-Z0-9]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|COOKIE|PAT|AUTH|SESSION)S?|PASS|PWD|SID|AUTHORIZATION|BEARER)$/u;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const ASSIGNMENT_NAME = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)\\?["']?[ \t]*([:=])[ \t]*/gu;
const ASSIGNMENT_VALUE = /(?!\[redacted)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\n]+)/uy;

function redactedAssignment(name: string, separator: string): boolean {
  return name.toUpperCase().split(/[_-]/u).some((part) => SECRET_NAME_PART.test(part))
    || (separator === "=" && ENVIRONMENT_NAME.test(name));
}

function redactSecretAssignments(text: string): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(ASSIGNMENT_NAME)) {
    if (match.index < last || !redactedAssignment(match[1]!, match[2]!)) continue;
    const valueStart = match.index + match[0].length;
    ASSIGNMENT_VALUE.lastIndex = valueStart;
    if (!ASSIGNMENT_VALUE.exec(text)) continue;
    result += `${text.slice(last, valueStart)}[redacted secret]`;
    last = ASSIGNMENT_VALUE.lastIndex;
  }
  return result + text.slice(last);
}

function scrubOnce(text: string, limit: number): string {
  return redactSecretAssignments(exposeSensitiveJsonKeys(text.slice(0, limit))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[redacted key]")
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[baprs])(?:[-_]|- )[A-Za-z0-9_-]+/giu, "[redacted token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted token]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/giu, "[redacted authorization]"))
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/giu, "[redacted URL]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu, "[redacted email]")
    .replace(/(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\)[^\n"'<>()[\]{}]*/gu, "[private path]")
    .replace(/(?:\$(?:HOME|\{HOME\}|USERPROFILE)|%USERPROFILE%)[\\/][^\s<>"']*/gu, "[private path]")
    .replace(/(?<![\w~])~?\/[^\s<>"']+/gu, "[private path]")
    .replace(/(?<!\w)(?:Users|home)[\\/][^\s<>"']+/gu, "[private path]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, limit).trim();
}

/** Deliberately lossy scrub for user-authored text, never a raw-log sanitizer. */
export function scrubReportText(text: string, limit = REPORT_TEXT_LIMIT): string {
  let result = scrubOnce(text, limit);
  for (let pass = 1; pass < 3; pass += 1) {
    const next = scrubOnce(result, limit);
    if (next === result) break;
    result = next;
  }
  return result;
}
