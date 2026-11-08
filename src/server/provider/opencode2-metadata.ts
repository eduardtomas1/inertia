import { AcpSecretRedactor } from "./acp-redaction";
import { openCode2Data } from "./opencode2-history";
import { openOwnedOpenCode2Server } from "./opencode2-server";
import { openCode2Models } from "./opencode2-support";

export async function readOpenCode2Models(executable: string, environment: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal, timeoutMs?: number, installationVersion?: string | null) {
  const server = await openOwnedOpenCode2Server({ executable, environment, cwd, signal, timeoutMs, installationVersion });
  try {
    const query = `?directory=${encodeURIComponent(cwd)}`;
    const catalog = await server.client.request("GET", `/api/model${query}`);
    const selected = openCode2Data(await server.client.request("GET", `/api/model/default${query}`));
    const redact = new AcpSecretRedactor(environment); redact.addSecrets(server.redactionSecrets);
    return redact.payload(openCode2Models(catalog, selected));
  } finally { await server.close(); }
}
