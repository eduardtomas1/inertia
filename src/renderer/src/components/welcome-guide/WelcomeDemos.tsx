import { Check, Search } from "lucide-react";

import type { WelcomeShortcut } from "../../utils/welcomeGuide";
import { AgentPixelGrid } from "../AgentPixelGrid";
import { WorkingOrb } from "../working-indicator/WorkingOrb";
import { useWorkingIndicator } from "../working-indicator/WorkingIndicatorContext";
import {
  orbMotionForPhase,
  resolveOrbMotion,
  usesOrbs,
} from "../working-indicator/orbMotion";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import type { WelcomeTopicId } from "./welcomeGuideModel";

const SPLIT_CHATS = [
  { slot: "a", title: "Onboarding" },
  { slot: "b", title: "Fix login" },
  { slot: "c", title: "Add tests" },
  { slot: "d", title: "Docs pass" },
];

const HUNKS = [
  { id: 1, kind: "add" },
  { id: 2, kind: "del" },
  { id: 3, kind: "add" },
  { id: 4, kind: "add" },
];

function SplitDemo(): React.JSX.Element {
  return (
    <>
      <span className="d-sidebar" />
      {SPLIT_CHATS.map((chat, index) => (
        <span key={chat.slot} className={`d-side is-${index}`}>{chat.title}</span>
      ))}
      {SPLIT_CHATS.map((chat) => (
        <span key={chat.slot} className={`d-pane is-${chat.slot}`}>
          <span className="d-pane-head"><i className="d-grip" /><b>{chat.title}</b></span>
          <i />
          <i />
          <i />
        </span>
      ))}
      {[1, 2, 3].map((drop) => <span key={drop} className={`d-drop is-${drop}`} />)}
      {SPLIT_CHATS.slice(1).map((chat, index) => (
        <span key={chat.slot} className={`d-chip is-${index + 1}`}>{chat.title}</span>
      ))}
    </>
  );
}

function WorkDemo(): React.JSX.Element {
  const indicator = useWorkingIndicator();
  const orb = usesOrbs(indicator) ? resolveOrbMotion(indicator, orbMotionForPhase("working")) : null;
  return (
    <>
      <span className="d-row is-live">
        <ProviderBrandIcon providerId="claude" decorative size={14} />
        <span className="d-row-text"><b>Fix login</b><small>inertia · main</small></span>
        <span className="d-status">
          <span className="is-busy">{orb ? <WorkingOrb size={14} design={orb.design} pace={orb.pace} /> : <AgentPixelGrid animated rhythm="orbit" />}<em>Working · 3m</em></span>
          <span className="is-done"><Check size={12} /><em>Completed</em></span>
        </span>
      </span>
      <span className="d-row is-quiet">
        <ProviderBrandIcon providerId="codex" decorative size={14} />
        <span className="d-row-text"><b>Update usage chart</b><small>inertia · usage</small></span>
        <span className="d-time">12m</span>
      </span>
    </>
  );
}

function DuoDemo(): React.JSX.Element {
  return (
    <>
      <span className="d-brief">One brief · Harden the updater</span>
      <span className="d-agents">
        <span className="d-agent is-a">
          <span className="d-agent-head"><ProviderBrandIcon providerId="claude" decorative size={13} />A · Claude</span>
          <i />
          <i />
          <i />
        </span>
        <span className="d-agent is-b">
          <span className="d-agent-head"><ProviderBrandIcon providerId="codex" decorative size={13} />B · Codex</span>
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="d-verdict"><Check size={11} />Judge: A covers the edge case</span>
    </>
  );
}

function ShipDemo(): React.JSX.Element {
  return (
    <>
      <span className="d-diff">
        <span className="d-file"><b>src/auth/login.ts</b><em className="is-add">+12</em><em className="is-del">−3</em></span>
        {HUNKS.map((hunk) => (
          <span key={hunk.id} className={`d-hunk is-${hunk.kind} is-${hunk.id}`}>
            <span>{hunk.kind === "add" ? "+" : "−"}</span>
            <i />
            <b><Check size={9} strokeWidth={3} /></b>
          </span>
        ))}
      </span>
      <span className="d-action">
        <span className="d-button">Create PR</span>
        <span className="d-pr"><Check size={11} />#412 · checks passed</span>
      </span>
    </>
  );
}

function LimitsDemo(): React.JSX.Element {
  return (
    <>
      <span className="d-card">
        <span className="d-card-head">
          <span className="d-logo"><ProviderBrandIcon providerId="claude" decorative size={16} /></span>
          <span className="d-row-text"><b>Claude</b><small>2 accounts · Weekly</small></span>
          <span className="d-ring"><i><b /></i><i><b /></i><em><span>62%</span></em></span>
        </span>
        <span className="d-meter is-personal"><small>Personal</small><span><i /></span></span>
        <span className="d-meter is-work"><small>Work</small><span><i /></span></span>
      </span>
      <span className="d-reset">Next reset in 1h 30m</span>
    </>
  );
}

function KeysDemo({ shortcuts }: { shortcuts: readonly WelcomeShortcut[] }): React.JSX.Element {
  return (
    <>
      <span className="d-keys">
        {shortcuts.map((shortcut) => (
          <span key={shortcut.label} className="d-key">
            <kbd>{shortcut.keys}</kbd>
            <small>{shortcut.label}</small>
          </span>
        ))}
      </span>
      <span className="d-palette">
        <span className="d-palette-input"><Search size={12} />Search Inertia…</span>
        <span className="is-hit"><b>Fix login</b><small>inertia</small></span>
        <span><b>Add tests</b><small>inertia</small></span>
      </span>
    </>
  );
}

export function WelcomeDemo({
  demo,
  shortcuts = [],
  leaving = false,
}: {
  demo: WelcomeTopicId;
  shortcuts?: readonly WelcomeShortcut[];
  leaving?: boolean;
}): React.JSX.Element {
  return (
    <span className={`d-stage is-${demo}${leaving ? " is-leaving" : ""}`}>
      {demo === "split" && <SplitDemo />}
      {demo === "work" && <WorkDemo />}
      {demo === "duo" && <DuoDemo />}
      {demo === "ship" && <ShipDemo />}
      {demo === "limits" && <LimitsDemo />}
      {demo === "keys" && <KeysDemo shortcuts={shortcuts} />}
    </span>
  );
}
