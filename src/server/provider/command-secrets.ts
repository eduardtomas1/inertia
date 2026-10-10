import { scrubSubagentSecrets } from "./subagent-trace";

const QUOTED_VALUE = String.raw`"[^"]*(?:"|$)|'[^']*(?:'|$)`;
const SECRET_VALUE = String.raw`${QUOTED_VALUE}|[^\s;&|]+`;
const ASSIGNMENT_NAME = String.raw`(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]{0,80})=`;
const SECRET_ASSIGNMENT =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]{0,80})=("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gu;
const QUOTED_SECRET_ASSIGNMENT = new RegExp(`${ASSIGNMENT_NAME}(${QUOTED_VALUE})`, "gu");
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL/iu;
const SECRET_FLAG = new RegExp(
  String.raw`(?<![\w-])(--?(?:[A-Za-z0-9]+[-_])*(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|secret[-_]?key|auth[-_]?token|access[-_]?token))(\s+|=)(?:${SECRET_VALUE})`,
  "giu",
);
const SHORT_PASSWORD_FLAG = new RegExp(
  String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb(?:-dump|-admin)?|(?:docker|podman|buildah|nerdctl)\s+login)\b[^;&|\n]*?\s-p)(\s*)(?:${SECRET_VALUE})`,
  "gu",
);
const CURL_USER_PASSWORD =
  /(\bcurl\b[^;&|\n]*?\s(?:-u|--user)(?:\s+|=))(?:(["'])([^:"'\n]+):[^"'\n]*\2|([^\s:"';&|]+):[^\s;&|]+)/gu;
const AWS_CONFIGURE_SECRET = new RegExp(
  String.raw`(\baws\s+configure\s+set\s+)([\w.-]+)(\s+)(?:${SECRET_VALUE})`,
  "gu",
);
const SECRET_HEADER =
  /(\b(?:(?:Proxy-)?Authorization|(?:X-)?[A-Za-z0-9-]*(?:Api-?Key|Auth-?Token|Access-?Token|Secret|Token))\s*:\s*)(?:(?:Bearer|Basic|Token|Digest|Bot)\s+)?[^\s'"]+/giu;

export function scrubCommandSecrets(command: string): string {
  return scrubSubagentSecrets(command)
    .replace(SECRET_FLAG, (_flag: string, name: string, separator: string) =>
      `${name}${separator}[redacted]`)
    .replace(SHORT_PASSWORD_FLAG, (_flag: string, prefix: string, separator: string) =>
      `${prefix}${separator}[redacted]`)
    .replace(
      CURL_USER_PASSWORD,
      (_user: string, prefix: string, quote: string | undefined, quotedUser: string | undefined, user: string | undefined) =>
        quote ? `${prefix}${quote}${quotedUser}:[redacted]${quote}` : `${prefix}${user}:[redacted]`,
    )
    .replace(AWS_CONFIGURE_SECRET, (setting: string, prefix: string, name: string, separator: string) =>
      SECRET_NAME.test(name) ? `${prefix}${name}${separator}[redacted]` : setting)
    .replace(SECRET_HEADER, "$1[redacted]")
    .replace(QUOTED_SECRET_ASSIGNMENT, (assignment: string, name: string) =>
      SECRET_NAME.test(name) ? `${name}=[redacted]` : assignment)
    .replace(
      SECRET_ASSIGNMENT,
      (assignment: string, name: string) => SECRET_NAME.test(name) ? `${name}=[redacted]` : assignment,
    );
}
