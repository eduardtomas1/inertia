import { createContext, lazy, Suspense, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import type { DelegationActions, DelegationSurface } from "./delegation-model";

const DelegationLineage = lazy(async () => ({ default: (await import("./delegation-panel")).DelegationLineage }));
const Actions = createContext<DelegationActions | null>(null);
const Data = createContext<DelegationSurface | null>(null);

export function useDelegationActions(): DelegationActions | null {
  return useContext(Actions);
}

export function useDelegationSurface(): DelegationSurface | null {
  return useContext(Data);
}

export function DelegationSurfaceProvider({ children, conversationId, delegation, conversations, run,
  openConversation }: DelegationSurface & { children: ReactNode }) {
  const actions = useMemo(() => ({ conversationId, run, openConversation }), [conversationId, run, openConversation]);
  const data = useMemo(() => ({ ...actions, delegation, conversations }), [actions, delegation, conversations]);
  return <Actions.Provider value={actions}><Data.Provider value={data}>{children}</Data.Provider></Actions.Provider>;
}

export function DelegationLineagePanel() {
  const surface = useContext(Data);
  const delegation = surface?.delegation;
  return surface && (delegation?.asChild || delegation?.asParent?.tasks.length)
    ? <Suspense fallback={null}><DelegationLineage key={surface.conversationId} surface={surface} /></Suspense> : null;
}
