import type { CSSProperties } from "react";
import clsx from "clsx";
import {
  BookOpen,
  Bot,
  Braces,
  Bug,
  Compass,
  Eye,
  FlaskConical,
  Paintbrush,
  PenLine,
  Rocket,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CustomAgentAccent, CustomAgentIcon, CustomAgentIconName } from "@shared/custom-agents";
import { PROJECT_COLOR_PALETTE } from "@shared/project-colors";
import "./CustomAgentAvatar.css";

export const CUSTOM_AGENT_SYMBOLS: Readonly<Record<CustomAgentIconName, LucideIcon>> = {
  bot: Bot,
  sparkles: Sparkles,
  shield: ShieldCheck,
  search: Search,
  wrench: Wrench,
  flask: FlaskConical,
  pen: PenLine,
  book: BookOpen,
  bug: Bug,
  compass: Compass,
  eye: Eye,
  brush: Paintbrush,
  rocket: Rocket,
  scale: Scale,
  zap: Zap,
  braces: Braces,
};

export interface CustomAgentIdentity {
  name: string;
  icon: CustomAgentIcon;
  accent: CustomAgentAccent;
}

export function customAgentTintStyle(accent: CustomAgentAccent): CSSProperties | undefined {
  if (!accent) return undefined;
  const tints = PROJECT_COLOR_PALETTE[accent];
  return { "--agent-tint-light": tints.light, "--agent-tint-dark": tints.dark } as CSSProperties;
}

export function CustomAgentAvatar({
  agent,
  size = 20,
  live = false,
  className,
}: {
  agent: CustomAgentIdentity;
  size?: number;
  live?: boolean;
  className?: string;
}): React.JSX.Element {
  const tint = customAgentTintStyle(agent.accent);
  const symbolSize = Math.max(10, Math.round(size * 0.58));
  const Symbol = agent.icon.kind === "symbol" ? CUSTOM_AGENT_SYMBOLS[agent.icon.name] ?? Bot : null;
  return (
    <span
      className={clsx("custom-agent-avatar", tint && "has-agent-tint", className)}
      style={{ ...tint, "--agent-avatar-size": `${size}px` } as CSSProperties}
      data-live={live ? "true" : undefined}
      data-icon-kind={agent.icon.kind}
      aria-hidden="true"
    >
      {Symbol
        ? <Symbol size={symbolSize} className="custom-agent-avatar-symbol" />
        : <img src={agent.icon.kind === "image" ? agent.icon.data : undefined} alt="" width={size} height={size} className="custom-agent-avatar-image" />}
    </span>
  );
}
