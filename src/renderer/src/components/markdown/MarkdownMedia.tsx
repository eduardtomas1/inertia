import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  Film,
  Maximize2,
  type LucideIcon,
} from "lucide-react";
import {
  applicationRendererScheme,
  workspaceImagePreviewUrl,
} from "@shared/workspace-image-preview";
import {
  buildWorkspaceMediaPreviewTarget,
  classifyWorkspaceMediaPath,
  workspaceMediaFileName,
  type WorkspaceMediaKind,
  type WorkspaceMediaPreviewTarget,
} from "@shared/workspace-media-preview";
import { workspaceFileReferenceFallback } from "../../utils/workspaceFileReference";
import { useMarkdownImageSchedule } from "./MarkdownImageScheduler";
import "./MarkdownMedia.css";

interface MeasuredImageGeometry {
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
}

const MAX_MEASURED_IMAGE_GEOMETRIES = 200;
const measuredImageGeometries = new Map<string, MeasuredImageGeometry>();

function rememberImageGeometry(source: string, geometry: MeasuredImageGeometry): void {
  if (geometry.renderedHeight <= 0 && (geometry.naturalWidth <= 0 || geometry.naturalHeight <= 0)) {
    return;
  }
  if (measuredImageGeometries.has(source)) {
    measuredImageGeometries.delete(source);
  } else if (measuredImageGeometries.size >= MAX_MEASURED_IMAGE_GEOMETRIES) {
    const oldest = measuredImageGeometries.keys().next().value;
    if (oldest !== undefined) measuredImageGeometries.delete(oldest);
  }
  measuredImageGeometries.set(source, geometry);
}

function preservedPlaceholderStyle(source: string): CSSProperties | undefined {
  const geometry = measuredImageGeometries.get(source);
  if (!geometry) return undefined;
  const style: CSSProperties = {};
  if (geometry.renderedWidth > 0) {
    style.width = `min(${geometry.renderedWidth}px, 100%)`;
  }
  if (geometry.renderedHeight > 0) {
    style.minHeight = `${geometry.renderedHeight}px`;
  }
  if (geometry.naturalWidth > 0 && geometry.naturalHeight > 0) {
    style.aspectRatio = `${geometry.naturalWidth} / ${geometry.naturalHeight}`;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

export function workspaceMediaPreviewTargetForPath(
  projectId: string,
  conversationId: string | undefined,
  relativePath: string,
): WorkspaceMediaPreviewTarget | null {
  if (!projectId || !relativePath) return null;
  return buildWorkspaceMediaPreviewTarget({
    projectId,
    conversationId,
    relativePath,
    scheme: applicationRendererScheme(globalThis.location?.protocol),
  });
}

export function workspaceMediaIcon(kind: WorkspaceMediaKind): LucideIcon {
  switch (kind) {
    case "image":
      return FileImage;
    case "video":
      return Film;
    case "audio":
      return FileAudio;
    case "pdf":
      return FileText;
    case "spreadsheet":
      return FileSpreadsheet;
  }
}

function documentBadgeLabel(target: WorkspaceMediaPreviewTarget): string {
  if (target.kind === "pdf") return "PDF";
  switch (target.extension) {
    case "csv":
      return "CSV";
    case "tsv":
      return "TSV";
    case "ods":
      return "ODS";
    default:
      return "Excel";
  }
}

function mediaFolder(target: WorkspaceMediaPreviewTarget): string {
  if (target.relativePath === target.name) return "";
  const folder = target.relativePath.slice(0, target.relativePath.length - target.name.length);
  return folder.replace(/[\\/]+$/u, "");
}

function MediaCardHeaderTitle({
  target,
  Icon,
}: {
  target: WorkspaceMediaPreviewTarget;
  Icon: LucideIcon;
}): React.JSX.Element {
  const folder = mediaFolder(target);
  return (
    <span className="response-markdown-media-title" title={target.relativePath}>
      <span className="response-markdown-media-glyph" aria-hidden="true">
        <Icon size={14} aria-hidden="true" />
      </span>
      <span className="response-markdown-media-filename">{target.name}</span>
      {folder && (
        <span className="response-markdown-media-folder" aria-hidden="true">{folder}</span>
      )}
    </span>
  );
}

function pauseMediaElement(element: HTMLMediaElement | null): void {
  if (!element) return;
  try {
    if (typeof element.pause === "function") element.pause();
  } catch {
    // Ignore media pause failures in non-media DOM environments (e.g. jsdom).
  }
}

function detachMediaElement(element: HTMLMediaElement | null): void {
  if (!element) return;
  pauseMediaElement(element);
  element.removeAttribute("src");
  try {
    if (typeof element.load === "function") element.load();
  } catch {
    // Ignore media load failures during unmount (e.g. jsdom).
  }
}

export function MarkdownInlineImageButton({
  target,
  alt,
  onPreviewMedia,
  children,
}: {
  target: WorkspaceMediaPreviewTarget;
  alt: string;
  onPreviewMedia: (target: WorkspaceMediaPreviewTarget) => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="response-markdown-image-button"
      aria-label={`Preview ${alt || target.name}`}
      onClick={() => onPreviewMedia(target)}
    >
      {children}
      <span className="response-markdown-image-zoom-cue" aria-hidden="true">
        <Maximize2 size={14} aria-hidden="true" />
      </span>
    </button>
  );
}

function MediaPlaybackFallback({
  target,
  kindLabel,
  onOpenProjectFile,
}: {
  target: WorkspaceMediaPreviewTarget;
  kindLabel: "video" | "audio";
  onOpenProjectFile?: (path: string) => void;
}): React.JSX.Element {
  const openExternally = (): void => {
    void window.inertia?.openProjectPath({
      projectId: target.projectId,
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      relativePath: target.relativePath,
      action: "open-externally",
    }).catch(() => undefined);
  };
  return (
    <span className="response-markdown-media-error" role="status">
      <span className="response-markdown-media-error-message">
        <CircleAlert size={16} aria-hidden="true" />
        <span>Couldn&apos;t play {kindLabel} {target.name}.</span>
      </span>
      <span className="response-markdown-media-error-actions">
        {onOpenProjectFile && (
          <button
            type="button"
            className="response-markdown-media-action"
            onClick={() => onOpenProjectFile(target.relativePath)}
          >
            Open in Files
          </button>
        )}
        <button
          type="button"
          className="response-markdown-media-action"
          onClick={openExternally}
        >
          Open externally
        </button>
      </span>
    </span>
  );
}

export function MarkdownInlineVideoCard({
  target,
  alt,
  title,
  interactive = true,
  onOpenProjectFile,
  onPreviewMedia,
}: {
  target: WorkspaceMediaPreviewTarget;
  alt: string;
  title?: string;
  interactive?: boolean;
  onOpenProjectFile?: (path: string) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === target.url;
  useEffect(() => {
    const element = videoRef.current;
    if (!interactive || !element || failed) return;
    element.src = target.url;
    return () => detachMediaElement(element);
  }, [interactive, target.url, failed]);
  if (!interactive) {
    return (
      <span
        className="response-markdown-media-card response-markdown-document-card"
        data-markdown-media-kind="video"
        data-markdown-media-ext={target.extension}
        data-markdown-media-alt={alt}
        data-markdown-media-source={target.relativePath}
        title={title}
      >
        <span className="response-markdown-document-button">
          <span className="response-markdown-document-tile" aria-hidden="true">
            <Film className="response-markdown-document-icon" size={16} aria-hidden="true" />
          </span>
          <span className="response-markdown-document-meta">
            <span className="response-markdown-document-name">{target.name}</span>
          </span>
          <span className="response-markdown-document-badge">Video</span>
        </span>
      </span>
    );
  }
  return (
    <span
      className="response-markdown-media-card response-markdown-video-card"
      data-markdown-media-kind="video"
      data-markdown-media-ext={target.extension}
      data-markdown-media-alt={alt}
      data-markdown-media-source={target.relativePath}
      title={title}
    >
      <span className="response-markdown-media-header">
        <MediaCardHeaderTitle target={target} Icon={Film} />
        {interactive && onPreviewMedia && (
          <button
            type="button"
            className="response-markdown-media-action"
            title={`Expand ${target.name}`}
            onClick={() => {
              pauseMediaElement(videoRef.current);
              onPreviewMedia(target);
            }}
          >
            <Maximize2 size={14} aria-hidden="true" />
            <span>Expand</span>
          </button>
        )}
      </span>
      {failed ? (
        <MediaPlaybackFallback
          target={target}
          kindLabel="video"
          onOpenProjectFile={interactive ? onOpenProjectFile : undefined}
        />
      ) : (
        <video
          ref={videoRef}
          className="response-markdown-video"
          controls
          preload="metadata"
          playsInline
          aria-label={alt || target.name}
          onError={() => setFailedUrl(target.url)}
        />
      )}
    </span>
  );
}

export function MarkdownInlineAudioCard({
  target,
  alt,
  title,
  interactive = true,
  onOpenProjectFile,
  onPreviewMedia,
}: {
  target: WorkspaceMediaPreviewTarget;
  alt: string;
  title?: string;
  interactive?: boolean;
  onOpenProjectFile?: (path: string) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === target.url;
  useEffect(() => {
    const element = audioRef.current;
    if (!interactive || !element || failed) return;
    element.src = target.url;
    return () => detachMediaElement(element);
  }, [interactive, target.url, failed]);
  if (!interactive) {
    return (
      <span
        className="response-markdown-media-card response-markdown-document-card"
        data-markdown-media-kind="audio"
        data-markdown-media-ext={target.extension}
        data-markdown-media-alt={alt}
        data-markdown-media-source={target.relativePath}
        title={title}
      >
        <span className="response-markdown-document-button">
          <span className="response-markdown-document-tile" aria-hidden="true">
            <FileAudio className="response-markdown-document-icon" size={16} aria-hidden="true" />
          </span>
          <span className="response-markdown-document-meta">
            <span className="response-markdown-document-name">{target.name}</span>
          </span>
          <span className="response-markdown-document-badge">Audio</span>
        </span>
      </span>
    );
  }
  return (
    <span
      className="response-markdown-media-card response-markdown-audio-card"
      data-markdown-media-kind="audio"
      data-markdown-media-ext={target.extension}
      data-markdown-media-alt={alt}
      data-markdown-media-source={target.relativePath}
      title={title}
    >
      <span className="response-markdown-media-header">
        <MediaCardHeaderTitle target={target} Icon={FileAudio} />
        {interactive && onPreviewMedia && (
          <button
            type="button"
            className="response-markdown-media-action"
            title={`Expand ${target.name}`}
            onClick={() => {
              pauseMediaElement(audioRef.current);
              onPreviewMedia(target);
            }}
          >
            <Maximize2 size={14} aria-hidden="true" />
            <span>Expand</span>
          </button>
        )}
      </span>
      {failed ? (
        <MediaPlaybackFallback
          target={target}
          kindLabel="audio"
          onOpenProjectFile={interactive ? onOpenProjectFile : undefined}
        />
      ) : (
        <span className="response-markdown-audio-body">
          <audio
            ref={audioRef}
            className="response-markdown-audio"
            controls
            preload="metadata"
            aria-label={alt || target.name}
            onError={() => setFailedUrl(target.url)}
          />
        </span>
      )}
    </span>
  );
}

export function MarkdownInlineDocumentCard({
  target,
  alt,
  title,
  interactive = true,
  onOpenProjectFile,
  onPreviewMedia,
}: {
  target: WorkspaceMediaPreviewTarget;
  alt: string;
  title?: string;
  interactive?: boolean;
  onOpenProjectFile?: (path: string) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
}): React.JSX.Element {
  const Icon = target.kind === "pdf" ? FileText : FileSpreadsheet;
  const badge = documentBadgeLabel(target);
  const handleOpen = (): void => {
    if (onPreviewMedia) {
      onPreviewMedia(target);
      return;
    }
    if (onOpenProjectFile) {
      onOpenProjectFile(target.relativePath);
      return;
    }
    void window.inertia?.openProjectPath({
      projectId: target.projectId,
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      relativePath: target.relativePath,
      action: "reveal",
    }).catch(() => undefined);
  };
  const cardContent = (
    <>
      <span className="response-markdown-document-tile" aria-hidden="true">
        <Icon className="response-markdown-document-icon" size={16} aria-hidden="true" />
      </span>
      <span className="response-markdown-document-meta">
        <span className="response-markdown-document-name">{target.name}</span>
        {target.relativePath !== target.name && (
          <span className="response-markdown-document-path">{target.relativePath}</span>
        )}
      </span>
      <span className="response-markdown-document-badge">{badge}</span>
      {interactive && (
        <ChevronRight className="response-markdown-document-chevron" size={16} aria-hidden="true" />
      )}
    </>
  );
  return (
    <span
      className="response-markdown-media-card response-markdown-document-card"
      data-markdown-media-kind={target.kind}
      data-markdown-media-ext={target.extension}
      data-markdown-media-alt={alt}
      data-markdown-media-source={target.relativePath}
      title={title}
    >
      {interactive ? (
        <button
          type="button"
          className="response-markdown-document-button"
          onClick={handleOpen}
        >
          {cardContent}
        </button>
      ) : (
        <span className="response-markdown-document-button">
          {cardContent}
        </span>
      )}
    </span>
  );
}

export function MarkdownOutsideLocalMediaFallback({
  path,
  url,
  alt,
  title,
  interactive = true,
}: {
  path: string;
  url: string;
  alt: string;
  title?: string;
  interactive?: boolean;
}): React.JSX.Element {
  const [error, setError] = useState(false);
  const descriptor = classifyWorkspaceMediaPath(path);
  const Icon = descriptor ? workspaceMediaIcon(descriptor.kind) : FileImage;
  const label = alt || workspaceMediaFileName(path) || path;
  return (
    <span
      className="response-markdown-local-media"
      data-markdown-image-alt={alt}
      data-markdown-image-source={path}
    >
      {interactive ? (
        <button
          type="button"
          className="response-markdown-local-media-link"
          data-local-media-kind={descriptor?.kind}
          title={title ?? path}
          onClick={() => {
            setError(false);
            void window.inertia?.openExternal(url).catch(() => setError(true));
          }}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="response-markdown-local-media-label">{label}</span>
          <ExternalLink className="response-markdown-local-media-external" size={14} aria-hidden="true" />
        </button>
      ) : (
        <span
          className="response-markdown-local-media-link"
          data-local-media-kind={descriptor?.kind}
          title={title ?? path}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="response-markdown-local-media-label">{label}</span>
        </span>
      )}
      {error && (
        <span className="response-copy-error" role="alert">
          The local file could not be opened.
        </span>
      )}
    </span>
  );
}

function ImageUnavailablePlaceholder({
  alt,
  reason,
  title,
  copyAttributes,
  style,
  overflow,
}: {
  alt: string;
  reason: string;
  title?: string;
  copyAttributes: {
    "data-markdown-image-alt": string;
    "data-markdown-image-source": string;
  };
  style?: CSSProperties;
  overflow?: boolean;
}): React.JSX.Element {
  const message = alt
    ? `${alt} (${reason})`
    : reason.charAt(0).toUpperCase() + reason.slice(1);
  const overflowAttribute = overflow ? "true" : undefined;
  return alt ? (
    <span
      className="response-markdown-image-unavailable"
      data-markdown-image-overflow={overflowAttribute}
      data-markdown-image-preserved={style ? "true" : undefined}
      role="img"
      aria-label={alt}
      title={title}
      style={style}
      {...copyAttributes}
    >
      {message}
    </span>
  ) : (
    <span
      className="response-markdown-image-unavailable"
      data-markdown-image-overflow={overflowAttribute}
      data-markdown-image-preserved={style ? "true" : undefined}
      aria-hidden="true"
      title={title}
      style={style}
      {...copyAttributes}
    >
      {message}
    </span>
  );
}

function MarkdownScheduledImage({
  trustedSource,
  previewTarget,
  alt,
  unavailableAlt,
  title,
  className,
  copyAttributes,
  interactive = true,
  onPreviewMedia,
}: {
  trustedSource: string;
  previewTarget: WorkspaceMediaPreviewTarget | null;
  alt: string;
  unavailableAlt: string;
  title?: string;
  className?: string;
  copyAttributes: {
    "data-markdown-image-alt": string;
    "data-markdown-image-source": string;
  };
  interactive?: boolean;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
}): React.JSX.Element {
  const schedule = useMarkdownImageSchedule(trustedSource);
  const imgRef = useRef<HTMLImageElement>(null);
  const waitingStyle = schedule.state === "waiting"
    ? preservedPlaceholderStyle(trustedSource)
    : undefined;
  useEffect(() => {
    if (schedule.state !== "loading") return;
    const image = imgRef.current;
    if (!image || !image.complete || image.naturalWidth <= 0) return;
    const rect = image.getBoundingClientRect();
    rememberImageGeometry(trustedSource, {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      renderedWidth: Math.round(rect.width),
      renderedHeight: Math.round(rect.height),
    });
    schedule.complete(false);
  }, [schedule, schedule.state, trustedSource]);
  const imageNode = (
    <img
      ref={imgRef}
      src={trustedSource}
      alt={alt}
      title={title}
      className={className}
      decoding="async"
      onLoad={(event) => {
        const image = event.currentTarget;
        const rect = image.getBoundingClientRect();
        rememberImageGeometry(trustedSource, {
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          renderedWidth: Math.round(rect.width),
          renderedHeight: Math.round(rect.height),
        });
        schedule.complete(false);
      }}
      onError={() => schedule.complete(true)}
    />
  );
  return (
    <span
      ref={schedule.shellRef}
      className="response-markdown-image-shell"
      data-markdown-image-state={schedule.state}
      {...copyAttributes}
    >
      {schedule.state === "loading" || schedule.state === "loaded" ? (
        interactive && onPreviewMedia && previewTarget ? (
          <MarkdownInlineImageButton
            target={previewTarget}
            alt={unavailableAlt}
            onPreviewMedia={onPreviewMedia}
          >
            {imageNode}
          </MarkdownInlineImageButton>
        ) : (
          imageNode
        )
      ) : schedule.state === "overflow" ? (
        <ImageUnavailablePlaceholder
          alt={unavailableAlt}
          reason="image not loaded: document image limit reached"
          title={title}
          copyAttributes={copyAttributes}
          overflow
        />
      ) : schedule.state === "error" ? (
        <ImageUnavailablePlaceholder
          alt={unavailableAlt}
          reason="image unavailable"
          title={title}
          copyAttributes={copyAttributes}
        />
      ) : (
        <ImageUnavailablePlaceholder
          alt={unavailableAlt}
          reason="image waiting to load"
          title={title}
          copyAttributes={copyAttributes}
          style={waitingStyle}
        />
      )}
    </span>
  );
}

export type MarkdownMediaTarget =
  | { kind: "external"; url: string }
  | { kind: "local"; path: string; url: string }
  | {
      kind: "project";
      relativePath: string;
      owner?: "project";
      literalPath?: boolean;
    }
  | { kind: "anchor"; href: string }
  | { kind: "unsafe" };

export function MarkdownMediaEmbed({
  target,
  alt,
  title,
  className,
  projectId,
  conversationId,
  interactive = true,
  onOpenProjectFile,
  onPreviewMedia,
}: {
  target: MarkdownMediaTarget;
  alt: string;
  title?: string;
  className?: string;
  projectId: string;
  conversationId?: string;
  interactive?: boolean;
  onOpenProjectFile?: (path: string) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
}): React.JSX.Element {
  const unavailableAlt = alt.trim();
  if (target.kind === "local") {
    return (
      <MarkdownOutsideLocalMediaFallback
        path={target.path}
        url={target.url}
        alt={unavailableAlt}
        title={title}
        interactive={interactive}
      />
    );
  }
  if (target.kind === "project") {
    const cleanedPath = target.literalPath
      ? target.relativePath
      : workspaceFileReferenceFallback(target.relativePath) ?? target.relativePath;
    if (projectId && cleanedPath && cleanedPath !== ".") {
      const effectiveConversationId = target.owner === "project" ? undefined : conversationId;
      const scheme = applicationRendererScheme(globalThis.location?.protocol);
      const descriptor = classifyWorkspaceMediaPath(cleanedPath);
      const previewTarget = descriptor
        ? buildWorkspaceMediaPreviewTarget({
            projectId,
            conversationId: effectiveConversationId,
            relativePath: cleanedPath,
            scheme,
          })
        : null;
      if (previewTarget?.kind === "video") {
        return (
          <MarkdownInlineVideoCard
            target={previewTarget}
            alt={unavailableAlt}
            title={title}
            interactive={interactive}
            onOpenProjectFile={onOpenProjectFile}
            onPreviewMedia={onPreviewMedia}
          />
        );
      }
      if (previewTarget?.kind === "audio") {
        return (
          <MarkdownInlineAudioCard
            target={previewTarget}
            alt={unavailableAlt}
            title={title}
            interactive={interactive}
            onOpenProjectFile={onOpenProjectFile}
            onPreviewMedia={onPreviewMedia}
          />
        );
      }
      if (previewTarget?.kind === "pdf" || previewTarget?.kind === "spreadsheet") {
        return (
          <MarkdownInlineDocumentCard
            target={previewTarget}
            alt={unavailableAlt}
            title={title}
            interactive={interactive}
            onOpenProjectFile={onOpenProjectFile}
            onPreviewMedia={onPreviewMedia}
          />
        );
      }
      const trustedSource = workspaceImagePreviewUrl({
        projectId,
        ...(effectiveConversationId ? { conversationId: effectiveConversationId } : {}),
        relativePath: cleanedPath,
      }, scheme);
      return (
        <MarkdownScheduledImage
          trustedSource={trustedSource}
          previewTarget={previewTarget}
          alt={alt}
          unavailableAlt={unavailableAlt}
          title={title}
          className={className}
          copyAttributes={{
            "data-markdown-image-alt": unavailableAlt,
            "data-markdown-image-source": cleanedPath,
          }}
          interactive={interactive}
          onPreviewMedia={onPreviewMedia}
        />
      );
    }
  }
  return (
    <ImageUnavailablePlaceholder
      alt={unavailableAlt}
      reason="image unavailable"
      title={title}
      copyAttributes={{
        "data-markdown-image-alt": unavailableAlt,
        "data-markdown-image-source": target.kind === "external"
          ? target.url
          : target.kind === "project"
            ? target.relativePath
            : "",
      }}
    />
  );
}
