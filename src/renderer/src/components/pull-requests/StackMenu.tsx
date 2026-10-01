import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, GitMerge, Layers, RefreshCw } from "lucide-react";
import { pullRequestIdentity, type LinkedPullRequest } from "@shared/pull-requests";
import { navigateMenuItems } from "../../utils/menuKeyboard";

const ENABLED_ITEM = '[role="menuitem"]:not([aria-disabled="true"])';

export function StackMenu({ link, links, reason, onSelect, onAction }: {
  link: LinkedPullRequest; links: LinkedPullRequest[]; reason: string | null;
  onSelect(link: LinkedPullRequest): void; onAction(action: "merge" | "rebase"): void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>(ENABLED_ITEM)?.focus();
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const stack = link.stack;
  if (!stack) return null;
  const index = stack.layers.findIndex((layer) => layer.number === link.number);
  const selectedCount = stack.layers.slice(0, index + 1).filter((layer) => layer.state === "open").length;
  const top = index === stack.layers.length - 1;
  const mergeReason = reason ?? (link.snapshot?.state !== "open" ? "Only an open pull request can be merged."
    : !selectedCount ? "No open layers to merge." : null);
  const rebaseReason = reason ?? (top ? null : "Open the top layer to rebase the whole stack.");
  const close = (): void => { setOpen(false); trigger.current?.focus(); };
  const act = (action: "merge" | "rebase", unavailable: string | null): void => {
    if (unavailable) return;
    close();
    onAction(action);
  };
  const label = `Stack #${stack.number} · layer ${index + 1} of ${stack.layers.length}`;
  return <div className="pr-stack" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") setOpen(false);
  }}>
    <button ref={trigger} type="button" className="workspace-surface-button pr-stack-trigger" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      <Layers size={14} strokeWidth={1.75} aria-hidden="true" /><span>{label}</span><ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {open && <div className="pr-stack-menu" role="menu" aria-label={`Stack #${stack.number}`} onKeyDown={(event) => navigateMenuItems(event, ENABLED_ITEM)}>
      <p className="pr-stack-menu-title">Stack #{stack.number} · top layer first</p>
      {[...stack.layers].reverse().map((layer) => {
        const linked = links.find((candidate) => pullRequestIdentity(candidate) === pullRequestIdentity({ ...link, number: layer.number }));
        const state = layer.draft ? "Draft" : layer.state === "merged" ? "Merged" : layer.state === "closed" ? "Closed" : "Open";
        return <button type="button" role="menuitem" key={layer.number} className="pr-stack-item" aria-disabled={!linked || undefined}
          aria-current={layer.number === link.number || undefined} onClick={() => {
            if (!linked) return;
            onSelect(linked);
            close();
          }}>
          <GitBranch size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>
            <strong>{linked?.snapshot?.title ?? layer.headBranch}</strong>
            <small>#{layer.number} · {layer.headBranch} · {linked ? state : `${state} · Not linked to this chat`}</small>
          </span>
          {layer.number === link.number && <Check size={14} strokeWidth={1.75} aria-hidden="true" />}
        </button>;
      })}
      <p className="pr-stack-base"><GitBranch size={14} strokeWidth={1.75} aria-hidden="true" /><span>{stack.base}</span><small>Base branch</small></p>
      <div className="pr-stack-menu-actions">
        <button type="button" role="menuitem" className="pr-stack-item" aria-disabled={Boolean(mergeReason) || undefined} onClick={() => act("merge", mergeReason)}>
          <GitMerge size={14} strokeWidth={1.75} aria-hidden="true" />
          <span><strong>Merge {selectedCount} {selectedCount === 1 ? "layer" : "layers"}…</strong>{mergeReason && <small>{mergeReason}</small>}</span>
        </button>
        <button type="button" role="menuitem" className="pr-stack-item" aria-disabled={Boolean(rebaseReason) || undefined} onClick={() => act("rebase", rebaseReason)}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          <span><strong>Rebase stack…</strong>{rebaseReason && <small>{rebaseReason}</small>}</span>
        </button>
      </div>
    </div>}
  </div>;
}
