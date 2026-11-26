import { useMemo, useRef } from "react";
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
  const { blocks: settledTexts, definitions } = split;
  const settledBlocks = useMemo(() => settledTexts.map((block, index) => (
    <div className="response-stream-block" data-stream-block="settled" key={index}>
      <ResponseMarkdown
        content={definitions ? `${block}\n\n${definitions}` : block}
        projectRoot={projectRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
      />
    </div>
  )), [
    conversationId,
    defaultCodeWrap,
    definitions,
    onOpenProjectFile,
    projectId,
    projectRoot,
    settledTexts,
  ]);
  if (!tail && settledBlocks.length > 0) return <>{settledBlocks}</>;
  const tailBlock = (
    <div className="response-stream-block" data-stream-block="tail" key={settledBlocks.length}>
      {tail}
    </div>
  );
  return <>{settledBlocks.length === 0 ? [tailBlock] : [...settledBlocks, tailBlock]}</>;
}
