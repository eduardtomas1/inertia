import type { AgentActivity } from "@shared/contracts";
import { activityDetailPresentation } from "../../utils/response-timeline/execution";
import { useFullActivityDetail } from "./activityDetailContext";

export function ActivityOutput({
  id,
  activity,
  full,
}: {
  id: string;
  activity: AgentActivity;
  full: string | null;
}): React.JSX.Element {
  const detail = useFullActivityDetail(activity, true);
  const output = activity.detailTruncated
    ? activityDetailPresentation({ ...activity, detail: detail.detail }).full
    : full;
  return (
    <pre className="agent-activity-output" id={id} aria-busy={detail.loading || undefined}>
      {output}
      {detail.loading && (
        <span className="agent-activity-output-status" role="status">{"\n…\nLoading the full output"}</span>
      )}
      {detail.error && (
        <span className="agent-activity-output-status" role="alert">
          {`\n${detail.error} `}
          <button type="button" className="agent-activity-output-retry" onClick={detail.retry}>Retry</button>
        </span>
      )}
    </pre>
  );
}
