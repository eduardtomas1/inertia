import type { CSSProperties } from "react";
import clsx from "clsx";
import {
  BookOpen,
  Braces,
  Bug,
  Eye,
  FlaskConical,
  Orbit,
  Paintbrush,
  PenLine,
  Rocket,
  Scale,
  Search,
  ShieldCheck,
  Star,
  Target,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CustomAgentAccent, CustomAgentIcon, CustomAgentIconName } from "@shared/custom-agents";
import { PROJECT_COLOR_PALETTE } from "@shared/project-colors";
import "./CustomAgentAvatar.css";

export const CUSTOM_AGENT_SYMBOLS: Readonly<Record<CustomAgentIconName, LucideIcon>> = {
  orbit: Orbit,
  star: Star,
  shield: ShieldCheck,
  search: Search,
  wrench: Wrench,
  flask: FlaskConical,
  pen: PenLine,
  book: BookOpen,
  bug: Bug,
  target: Target,
  eye: Eye,
  brush: Paintbrush,
  rocket: Rocket,
  scale: Scale,
  zap: Zap,
  braces: Braces,
};

const GLYPH_PLATE_FROM = 40;
const MARK_SHADOW_FROM = 28;

function markInset(size: number): number {
  return size <= 24 ? 0 : size < 48 ? 2 : 4;
}

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
  const symbolSize = size > 24 ? 16 : 14;
  const { icon } = agent;
  const Symbol = icon.kind === "symbol" ? CUSTOM_AGENT_SYMBOLS[icon.name] ?? Orbit : null;
  const inset = icon.kind === "mark" ? markInset(size) : null;
  return (
    <span
      className={clsx("custom-agent-avatar", tint && "has-agent-tint", className)}
      style={{ ...tint, "--agent-avatar-size": `${size}px`, ...(inset === null ? null : { "--agent-mark-inset": `${inset}px` }) } as CSSProperties}
      data-live={live ? "true" : undefined}
      data-icon-kind={icon.kind}
      data-mark={icon.kind === "mark" ? icon.name : undefined}
      aria-hidden="true"
    >
      {inset !== null
        ? <span className="custom-agent-avatar-figure" data-shadow={size - 2 * inset >= MARK_SHADOW_FROM ? "true" : undefined} />
        : Symbol && size >= GLYPH_PLATE_FROM
          ? <span className="custom-agent-avatar-glyph"><Symbol size={symbolSize} className="custom-agent-avatar-symbol" /></span>
          : Symbol
            ? <Symbol size={symbolSize} className="custom-agent-avatar-symbol" />
            : <img src={icon.kind === "image" ? icon.data : undefined} alt="" width={size} height={size} className="custom-agent-avatar-image" />}
    </span>
  );
}
