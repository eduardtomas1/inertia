import { useEffect, useRef, useState } from "react";

import type { AppSnapshot } from "@shared/contracts";

export function useProjectScope(
  snapshot: AppSnapshot | null,
): [string | null, (projectId: string | null) => void] {
  const [projectScopeId, setProjectScopeId] = useState<string | null>(null);
  const knownProjectIdsRef = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const known = knownProjectIdsRef.current;
    const current = new Set(snapshot.projects.map(({ id }) => id));
    knownProjectIdsRef.current = current;
    const activeId = snapshot.activeProjectId;
    if (known && activeId && current.has(activeId) && !known.has(activeId)) setProjectScopeId(activeId);
  }, [snapshot]);
  return [projectScopeId, setProjectScopeId];
}
