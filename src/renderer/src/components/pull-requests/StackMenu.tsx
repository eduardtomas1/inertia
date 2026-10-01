import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, GitMerge, Layers, RefreshCw } from "lucide-react";
import { pullRequestIdentity, type LinkedPullRequest } from "@shared/pull-requests";
import { navigateMenuItems } from "../../utils/menuKeyboard";
export function StackMenu({ link, links, disabled, onSelect, onAction }: {
  link: LinkedPullRequest; links: LinkedPullRequest[]; disabled: boolean;
  onSelect(link: LinkedPullRequest): void; onAction(action: "merge" | "rebase"): void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const stack = link.stack;
  if (!stack) return null;
  const index = stack.layers.findIndex((layer) => layer.number === link.number);
  const selectedCount = stack.layers.slice(0, index + 1).filter((layer) => layer.state === "open").length;
  return <div className="pr-stack-control" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (event.key === "Tab") setOpen(false);
  }}>
    <button ref={trigger} type="button" className="pr-stack-trigger" aria-haspopup="menu" aria-expanded={open}
      aria-label={`Stack ${stack.number}, layer ${index + 1} of ${stack.layers.length}`} onClick={() => setOpen(!open)}>
      <Layers size={14} /><span>{index + 1}/{stack.layers.length}</span><ChevronDown size={12} />
    </button>
    {open && <div className="pr-stack-menu" role="menu" aria-label={`Stack ${stack.number}`} onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]:not(:disabled)')}>
      <small className="pr-stack-heading">Stack #{stack.number}</small>
      {[...stack.layers].reverse().map((layer) => {
        const linked = links.find((candidate) => pullRequestIdentity(candidate) === pullRequestIdentity({ ...link, number: layer.number }));
        return <button type="button" role="menuitem" key={layer.number} disabled={!linked} onClick={() => {
          if (linked) onSelect(linked); setOpen(false); trigger.current?.focus();
        }}><GitBranch size={14} /><span><strong>{linked?.snapshot?.title ?? layer.headBranch}</strong><small>#{layer.number} · {layer.headBranch} · {layer.draft ? "Draft" : layer.state}</small></span>{layer.number === link.number && <Check size={13} />}</button>;
      })}
      <div className="pr-stack-base"><GitBranch size={12} />{stack.base}</div>
      <div className="pr-stack-menu-actions">
        <button type="button" role="menuitem" disabled={disabled || !selectedCount || link.snapshot?.state !== "open"} onClick={() => { setOpen(false); onAction("merge"); }}><GitMerge size={14} />Merge stack ({selectedCount})</button>
        <button type="button" role="menuitem" disabled={disabled || index !== stack.layers.length - 1} title={index !== stack.layers.length - 1 ? "Select the top layer to rebase the whole stack" : undefined}
          onClick={() => { setOpen(false); onAction("rebase"); }}><RefreshCw size={14} />Rebase stack</button>
      </div>
    </div>}
  </div>;
}
