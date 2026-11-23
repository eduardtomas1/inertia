import { useMemo, type ReactNode } from "react";

import type { ServerEvent } from "@shared/contracts";
import type { ConnectionStatus } from "../../hooks/useInertiaConnection";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { ActivityDetailReaderContext, createActivityDetailReader } from "./activityDetailContext";
import { HtmlRenderRuntimeStatusContext } from "./html-render-runtime";

export function TimelineRuntimeProviders({
  status,
  request,
  children,
}: {
  status: ConnectionStatus;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  children: ReactNode;
}): React.JSX.Element {
  const reader = useMemo(() => createActivityDetailReader(request), [request]);
  return (
    <HtmlRenderRuntimeStatusContext.Provider value={status}>
      <ActivityDetailReaderContext.Provider value={reader}>{children}</ActivityDetailReaderContext.Provider>
    </HtmlRenderRuntimeStatusContext.Provider>
  );
}
