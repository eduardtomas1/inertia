import type { MascotPhase } from "../../../shared/mascot";

type Artwork = "idle" | "thinking" | "working" | "idea" | "pickup";
type ArtworkFiles = { animation: string; poster: string };

/** Read Vite-resolved URLs from inert HTML; inactive animations never load. */
export function readMascotAssets(root: HTMLElement): Record<Artwork, ArtworkFiles> {
  const template = root.querySelector<HTMLTemplateElement>("#mascot-artwork")!;
  const assets = {} as Record<Artwork, ArtworkFiles>;
  for (const picture of template.content.querySelectorAll("picture")) {
    assets[picture.dataset.artwork as Artwork] = {
      animation: picture.querySelector("source")!.getAttribute("srcset")!,
      poster: picture.querySelector("img")!.getAttribute("src")!,
    };
  }
  return assets;
}

export function mascotArtwork(phase: MascotPhase): Artwork {
  if (phase === "completed") return "idea";
  if (["queued", "starting", "retrying", "waiting-for-input", "waiting-for-approval"].includes(phase)) return "thinking";
  if (phase === "running" || phase === "delegated" || phase === "cancelling") return "working";
  return "idle";
}
