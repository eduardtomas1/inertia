import type { MascotFeed } from "../shared/mascot-feed.js";
import type { MascotMain } from "./mascot-main.js";

export class MascotFeedMemory {
  private feed: MascotFeed | null = null;
  private phase: string | null = null;

  status(feed: MascotFeed | null): void {
    this.feed = feed;
  }

  runtimePhase(phase: string): void {
    this.phase = phase;
    if (phase !== "ready") this.feed = null;
  }

  replay(mascot: Pick<MascotMain, "observe" | "runtimePhase">): void {
    if (this.phase) mascot.runtimePhase(this.phase);
    if (this.feed) mascot.observe(this.feed);
  }
}
