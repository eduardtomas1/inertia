import { useEffect, useRef, useState } from "react";

import type { ProviderId, ProviderSlashCommand } from "@shared/contracts";
import type { ProviderCommandsLoader } from "../../hooks/useAgentWorkflows";

const NO_COMMANDS: readonly ProviderSlashCommand[] = [];

/**
 * The slash commands this chat's provider reports, fetched each time the
 * composer's slash menu opens. The last answer per project and provider stays
 * visible while a refresh is in flight. A provider that learns its commands
 * during a session (ACP) is picked up on the next open. Failures keep the
 * menu to Inertia's own commands.
 */
export function useProviderSlashCommands({
  load,
  projectId,
  providerId,
  menuOpen,
}: {
  load: ProviderCommandsLoader | undefined;
  projectId: string;
  providerId: ProviderId;
  menuOpen: boolean;
}): readonly ProviderSlashCommand[] {
  const key = `${projectId}\0${providerId}`;
  const [loaded, setLoaded] = useState<ReadonlyMap<string, readonly ProviderSlashCommand[]>>(
    () => new Map(),
  );
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!menuOpen || !load || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    void load(projectId, providerId).then(
      (commands) => {
        setLoaded((current) => new Map(current).set(key, commands));
      },
      () => undefined,
    ).finally(() => {
      inFlight.current.delete(key);
    });
  }, [key, load, menuOpen, projectId, providerId]);
  return loaded.get(key) ?? NO_COMMANDS;
}
