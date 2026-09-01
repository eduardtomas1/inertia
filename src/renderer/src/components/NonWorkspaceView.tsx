import type { Project } from "@shared/contracts";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { HomeView } from "./HomeView";
import { UsageView, type UsageViewProps } from "./UsageView";

interface NonWorkspaceViewProps {
  view: "home" | "usage";
  connection: {
    snapshot: { projects: Project[] } | null;
    status: ConnectionStatus;
  };
  busyAction: string | null;
  actions: {
    createConversation: (project: Project) => void;
    importProject: () => Promise<void>;
  };
  usage: UsageViewProps;
}

export default function NonWorkspaceView({
  view,
  connection,
  busyAction,
  actions,
  usage,
}: NonWorkspaceViewProps): React.JSX.Element {
  return view === "usage"
    ? <UsageView {...usage} />
    : (
        <HomeView
          connection={connection}
          busyAction={busyAction}
          actions={actions}
        />
      );
}
