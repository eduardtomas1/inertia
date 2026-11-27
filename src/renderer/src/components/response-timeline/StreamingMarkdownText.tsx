import { useMemo, useRef } from "react";
import type { WorkspaceMediaPreviewTarget } from "@shared/workspace-media-preview";
import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";
import { MarkdownImageSchedulerProvider } from "../markdown/MarkdownImageScheduler";
import { ResponseMarkdown } from "../ResponseMarkdown";
import {
  splitStreamingMarkdown,
  streamingMarkdownTail,
  type StreamingMarkdownSplit,
} from "../../utils/streamingMarkdownSplit";

export function StreamingMarkdownText({
  content,
  projectRoot,
  projectBaseRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  onOpenProjectFile,
  onPreviewMedia,
}: {
  content: string;
  projectRoot: string;
  projectBaseRoot?: string;
  projectId: string;
  conversationId?: string;
  defaultCodeWrap: boolean;
  onOpenProjectFile?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
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
        projectBaseRoot={projectBaseRoot}
        projectId={projectId}
        conversationId={conversationId}
        defaultCodeWrap={defaultCodeWrap}
        onOpenProjectFile={onOpenProjectFile}
        onPreviewMedia={onPreviewMedia}
      />
    </div>
  )), [
    conversationId,
    defaultCodeWrap,
    definitions,
    onOpenProjectFile,
    onPreviewMedia,
    projectBaseRoot,
    projectId,
    projectRoot,
    settledTexts,
  ]);
  const schedulerIdentity = [
    projectRoot,
    projectBaseRoot ?? "",
    projectId,
    conversationId ?? "",
  ].join("\0");
  if (!tail && settledBlocks.length > 0) {
    return (
      <MarkdownImageSchedulerProvider key={schedulerIdentity}>
        {settledBlocks}
      </MarkdownImageSchedulerProvider>
    );
  }
  const tailBlock = (
    <div className="response-stream-block" data-stream-block="tail" key={settledBlocks.length}>
      {tail}
    </div>
  );
  return (
    <MarkdownImageSchedulerProvider key={schedulerIdentity}>
      {settledBlocks.length === 0 ? [tailBlock] : [...settledBlocks, tailBlock]}
    </MarkdownImageSchedulerProvider>
  );
}
