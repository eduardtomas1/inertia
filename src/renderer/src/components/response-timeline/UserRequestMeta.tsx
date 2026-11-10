import { formatFullDateTime, formatMessageTime } from "../../lib/format";
import { useCopiedState } from "../../hooks/useCopiedState";
import { InertiaMorphIcon } from "../motion/InertiaMorphIcon";
import { checkMorphIcon, copyMorphIcon } from "../motion/lucideMorphData";
import { TooltipButton } from "../TooltipButton";
import { TooltipText } from "../TooltipText";

export function UserRequestMeta({
  content,
  createdAt,
  showTime,
}: {
  content: string;
  createdAt: string;
  showTime: boolean;
}): React.JSX.Element {
  const { copied, error, copy } = useCopiedState();
  const label = error ? "Copy failed" : copied ? "Message copied" : "Copy message";
  return (
    <div className="turn-user-request-meta" data-turn-layer="user-request-meta">
      {showTime && (
        <TooltipText className="turn-user-request-time" tooltip={formatFullDateTime(createdAt)}>
          <time dateTime={createdAt}>{formatMessageTime(createdAt)}</time>
        </TooltipText>
      )}
      <TooltipButton
        className="turn-user-request-copy"
        tooltip={label}
        aria-label={label}
        onClick={() => void copy(content)}
      >
        <InertiaMorphIcon
          icon={copied ? checkMorphIcon : copyMorphIcon}
          iconState={copied ? "copied" : "copy"}
          size={14}
        />
      </TooltipButton>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? "Message copied." : ""}
      </span>
      {error && <span className="visually-hidden" role="alert">{error}</span>}
    </div>
  );
}
