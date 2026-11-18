import { useEffect, useRef, useState } from "react";

import type { Conversation, ProviderSlashCommand } from "@shared/contracts";
import type { ProviderCommandsLoader } from "../../hooks/useAgentWorkflows";

const NO_COMMANDS: readonly ProviderSlashCommand[] = [];

export type ProviderCommandsConversation = Pick<Conversation, "id" | "projectId" | "providerId" | "modelSelection">;

export function useProviderSlashCommands({
  load,
  conversation,
  menuOpen,
}: {
  load: ProviderCommandsLoader | undefined;
  conversation: ProviderCommandsConversation | null;
  menuOpen: boolean;
}): readonly ProviderSlashCommand[] {
  const id = conversation?.id ?? null;
  const projectId = conversation?.projectId ?? null;
  const providerId = conversation?.providerId ?? null;
  const harnessId = conversation?.modelSelection.harnessId ?? null;
  const key = id && projectId && providerId ? `${id}\0${projectId}\0${providerId}\0${harnessId ?? ""}` : null;
  const [loaded, setLoaded] = useState<ReadonlyMap<string, readonly ProviderSlashCommand[]>>(
    () => new Map(),
  );
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!menuOpen || !load || !key || !id || !projectId || !providerId || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    void load({ id, projectId, providerId }).then(
      (commands) => {
        setLoaded((current) => new Map(current).set(key, commands));
      },
      () => {
        setLoaded((current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
      },
    ).finally(() => {
      inFlight.current.delete(key);
    });
  }, [id, key, load, menuOpen, projectId, providerId]);
  return key && load ? loaded.get(key) ?? NO_COMMANDS : NO_COMMANDS;
}
