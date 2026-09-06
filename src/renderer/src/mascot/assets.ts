import idle from "../assets/mascot/idle.webp?no-inline";
import idlePoster from "../assets/mascot/idle.png?no-inline";
import thinking from "../assets/mascot/thinking.webp?no-inline";
import thinkingPoster from "../assets/mascot/thinking.png?no-inline";
import working from "../assets/mascot/working.webp?no-inline";
import workingPoster from "../assets/mascot/working.png?no-inline";
import idea from "../assets/mascot/idea.webp?no-inline";
import ideaPoster from "../assets/mascot/idea.png?no-inline";
import type { MascotPhase } from "../../../shared/mascot";

export const mascotAssets = {
  idle: { animation: idle, poster: idlePoster },
  thinking: { animation: thinking, poster: thinkingPoster },
  working: { animation: working, poster: workingPoster },
  idea: { animation: idea, poster: ideaPoster },
};

export function mascotArtwork(phase: MascotPhase): keyof typeof mascotAssets {
  if (phase === "completed") return "idea";
  if (["queued", "starting", "retrying", "waiting-for-input", "waiting-for-approval"].includes(phase)) return "thinking";
  if (phase === "running" || phase === "delegated" || phase === "cancelling") return "working";
  return "idle";
}
