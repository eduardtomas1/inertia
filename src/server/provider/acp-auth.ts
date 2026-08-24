import type { AuthMethod, AuthMethodAgent } from "@agentclientprotocol/sdk";

/**
 * Inertia does not advertise ACP terminal authentication. A conforming agent
 * therefore only returns agent-owned methods, whose discriminator is omitted.
 */
export function selectAcpAgentAuthMethod(
  providerName: string,
  methods: AuthMethod[] | null | undefined,
  methodId: string,
): AuthMethodAgent | undefined {
  if (methods?.some((method) => "type" in method)) {
    throw new Error(
      `${providerName} ACP advertised terminal authentication without client terminal support.`,
    );
  }
  return methods?.find((method): method is AuthMethodAgent =>
    !("type" in method) && method.id === methodId,
  );
}
