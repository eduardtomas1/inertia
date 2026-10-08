import { scrubSubagentSecrets } from "./subagent-trace";

const SECRET_ASSIGNMENT =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]{0,80})=("[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gu;
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL/iu;

export function scrubCommandSecrets(command: string): string {
  return scrubSubagentSecrets(command).replace(
    SECRET_ASSIGNMENT,
    (assignment: string, name: string) => SECRET_NAME.test(name) ? `${name}=[redacted]` : assignment,
  );
}
