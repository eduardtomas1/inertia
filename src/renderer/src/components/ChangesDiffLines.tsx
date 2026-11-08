import { Fragment, useMemo, useRef, type KeyboardEvent, type ReactNode, type WheelEvent } from "react";
import clsx from "clsx";
import type { DiffHunk, DiffLine } from "@shared/contracts";

import type { DiffViewMode } from "../hooks/useDiffViewMode";
import { intralineSegments, type DiffHunkRender } from "../utils/diffHighlighting";
import { diffSplitRowLines, diffSplitRows, type DiffSplitRow } from "../utils/diffSplitRows";

export type ChangesDiffLinesProps = {
  hunk: DiffHunk;
  render: DiffHunkRender;
  view: DiffViewMode;
  selectedLineIds: readonly string[] | null;
  reviewLocked: boolean;
  /** Rendered once, after the last selected line (unified) or row (split). */
  popover: ReactNode;
  onChooseLine: (index: number, extend: boolean) => void;
};

type SplitSide = "old" | "new";

/** Monospace display width in `ch`: tabs stop every 8 columns, wide glyphs take two. */
export function diffDisplayColumns(text: string): number {
  let columns = 0;
  for (const character of text) {
    if (character === "\t") columns += 8 - (columns % 8);
    else columns += (character.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
  }
  return columns;
}

function linePrefix(line: DiffLine): string {
  return line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " ";
}

/**
 * Highlighted markup has been verified by `markedHighlightHtml` to be
 * highlight.js spans around escaped text equal to the line content; any other
 * line renders through React text nodes.
 */
function DiffLineText({ line, render, index }: { line: DiffLine; render: DiffHunkRender; index: number }): React.JSX.Element {
  const html = render.html[index] ?? null;
  if (html !== null) return <span className="diff-line-content hljs" dangerouslySetInnerHTML={{ __html: html || " " }} />;
  const ranges = render.ranges[index];
  if (ranges && ranges.length > 0) {
    return (
      <span className="diff-line-content">
        {intralineSegments(line.content, ranges).map((segment, position) => (
          <Fragment key={position}>{segment.changed ? <mark className="diff-intraline">{segment.text}</mark> : segment.text}</Fragment>
        ))}
      </span>
    );
  }
  return <span className="diff-line-content">{line.content || " "}</span>;
}

export function ChangesDiffLines({
  hunk,
  render,
  view,
  selectedLineIds,
  reviewLocked,
  popover,
  onChooseLine,
}: ChangesDiffLinesProps): React.JSX.Element {
  const selected = useMemo(() => new Set(selectedLineIds ?? []), [selectedLineIds]);
  const rows = useMemo(() => view === "split" ? diffSplitRows(hunk.lines) : null, [hunk.lines, view]);
  const sideColumns = useMemo(() => {
    const widths = { old: 0, new: 0 };
    if (view !== "split") return widths;
    for (const line of hunk.lines) {
      const columns = diffDisplayColumns(line.content);
      if (line.kind !== "addition") widths.old = Math.max(widths.old, columns);
      if (line.kind === "addition" || line.kind === "context") widths.new = Math.max(widths.new, columns);
    }
    return widths;
  }, [hunk.lines, view]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineProps = (index: number) => {
    const line = hunk.lines[index]!;
    return {
      type: "button" as const,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => onChooseLine(index, event.shiftKey),
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "Enter" || !event.shiftKey) return;
        event.preventDefault();
        onChooseLine(index, true);
      },
      disabled: line.kind === "meta",
      "aria-disabled": reviewLocked || undefined,
      "aria-keyshortcuts": "Shift+Enter",
    };
  };
  const lineClass = (line: DiffLine, ...extra: string[]) => clsx("diff-line", `is-${line.kind}`, selected.has(line.id) && "is-selected", ...extra);

  if (!rows) {
    const lastSelectedId = selected.size > 0 ? hunk.lines.filter((line) => selected.has(line.id)).at(-1)?.id : null;
    return (
      <>
        {hunk.lines.map((line, index) => (
          <div key={line.id}>
            <button className={lineClass(line)} {...lineProps(index)}>
              <span className="diff-line-number" aria-hidden="true">{line.oldLineNumber ?? ""}</span><span className="diff-line-number" aria-hidden="true">{line.newLineNumber ?? ""}</span><span className="diff-line-prefix">{linePrefix(line)}</span><DiffLineText line={line} render={render} index={index} />
            </button>
            {line.id === lastSelectedId && popover}
          </div>
        ))}
      </>
    );
  }

  let lastSelectedRow = -1;
  if (selected.size > 0) {
    rows.forEach((row, position) => {
      if (diffSplitRowLines(row).some((index) => selected.has(hunk.lines[index]!.id))) lastSelectedRow = position;
    });
  }
  const scroller = (side: SplitSide) => bodyRef.current?.querySelector<HTMLElement>(`.diff-split-scroller[data-side="${side}"]`) ?? null;
  // Trackpads and Shift+wheel scroll the column under the pointer.
  const scrollColumn = (event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    const side = (event.target as Element).closest?.("[data-side]")?.getAttribute("data-side");
    if (side !== "old" && side !== "new") return;
    const target = scroller(side);
    if (target) target.scrollLeft += event.deltaX;
  };
  const cell = (index: number | null, side: SplitSide) => {
    if (index === null) return <div className="diff-split-placeholder" data-side={side} aria-hidden="true" />;
    const line = hunk.lines[index]!;
    return (
      <button className={lineClass(line, "diff-split-cell")} data-side={side} {...lineProps(index)}>
        <span className="diff-line-number" aria-hidden="true">{(side === "old" ? line.oldLineNumber : line.newLineNumber) ?? ""}</span><span className="diff-line-prefix">{linePrefix(line)}</span><span className="diff-split-clip"><DiffLineText line={line} render={render} index={index} /></span>
      </button>
    );
  };
  const rowContent = (row: DiffSplitRow) => {
    if (row.kind === "change") return <>{cell(row.left, "old")}{cell(row.right, "new")}</>;
    const line = hunk.lines[row.index]!;
    // A context line is one control spanning both columns; the new-side copy
    // is presentational so assistive technology reads the line once.
    return (
      <button className={lineClass(line, "diff-split-context")} {...lineProps(row.index)}>
        <span className="diff-split-half" data-side="old"><span className="diff-line-number" aria-hidden="true">{line.oldLineNumber ?? ""}</span><span className="diff-line-prefix">{linePrefix(line)}</span><span className="diff-split-clip"><DiffLineText line={line} render={render} index={row.index} /></span></span>
        <span className="diff-split-half" data-side="new" aria-hidden="true">{row.kind === "context" && <><span className="diff-line-number">{line.newLineNumber ?? ""}</span><span className="diff-line-prefix">{linePrefix(line)}</span><span className="diff-split-clip"><DiffLineText line={line} render={render} index={row.index} /></span></>}</span>
      </button>
    );
  };
  // Each column scrolls horizontally on its own: the scrollers below set a
  // per-side offset that the clipped line content follows, so rows stay aligned.
  return (
    <div className="diff-split-body" ref={bodyRef} onWheel={scrollColumn}>
      {rows.map((row, position) => (
        <div key={diffSplitRowLines(row).map((index) => hunk.lines[index]!.id).join("\0")}>
          <div className="diff-split-row">{rowContent(row)}</div>
          {position === lastSelectedRow && popover}
        </div>
      ))}
      <div className="diff-split-scrollbars">
        {(["old", "new"] as const).map((side) => (
          <div className="diff-split-scroll-gutter" key={side}>
            <div
              className="diff-split-scroller"
              data-side={side}
              role="group"
              aria-label={`Scroll ${side === "old" ? "original" : "changed"} lines sideways`}
              tabIndex={0}
              onScroll={(event) => bodyRef.current?.style.setProperty(`--diff-scroll-${side}`, `${event.currentTarget.scrollLeft}px`)}
            >
              <div style={{ width: `calc(${sideColumns[side]}ch + 14px)` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
