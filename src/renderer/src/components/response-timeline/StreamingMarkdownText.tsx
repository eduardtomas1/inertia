import { useRef } from "react";
import { ResponseMarkdown } from "../ResponseMarkdown";
import {
  splitStreamingMarkdown,
  streamingMarkdownTail,
  type StreamingMarkdownSplit,
} from "../../utils/streamingMarkdownSplit";

export function StreamingMarkdownText({
  content,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
}: {
  content: string;
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile?: (path: string) => void;
}): React.JSX.Element {
  const splitRef = useRef<StreamingMarkdownSplit | undefined>(undefined);
  const split = splitStreamingMarkdown(content, splitRef.current);
  splitRef.current = split;
  const tail = streamingMarkdownTail(split);
  const blocks = split.blocks.map((block, index) => (
    <div className="response-stream-block" data-stream-block="settled" key={index}>
      <ResponseMarkdown
        content={block}
        projectRoot={projectRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
      />
    </div>
  ));
  if (tail || blocks.length === 0) {
    blocks.push(
      <div className="response-stream-block" data-stream-block="tail" key={blocks.length}>
        {tail}
      </div>,
    );
  }
  return <>{blocks}</>;
}
