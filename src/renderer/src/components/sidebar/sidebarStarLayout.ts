/**
 * The fixed sky behind the sidebar brand: a few far stars and four near ones.
 * Positions come from a seeded generator that runs once when the module loads,
 * so every render, window and test sees the same stars. Horizontal positions
 * are percentages of the sidebar width and vertical positions are pixels, so
 * the stars keep their size when the sidebar is resized and every check holds
 * at any width the layout allows. Candidates lean toward the upper right and
 * thin out toward the wordmark. Stars that could reach the macOS lockup,
 * which sits right of the traffic lights, are kept but marked so macOS hides
 * them.
 */
export const SIDEBAR_STARFIELD_SEED = 49;
export const SIDEBAR_STAR_DEPTHS = { near: 4, far: 8 } as const;
export const SIDEBAR_STARFIELD_WIDTHS = { min: 220, reference: 276, max: 420 } as const;
export const SIDEBAR_STAR_SPACING = 22;
export const SIDEBAR_STAR_BRAND_CLEARANCE = 14;

export type SidebarStarDepth = keyof typeof SIDEBAR_STAR_DEPTHS;

export interface SidebarStarBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface SidebarStar {
  /** Percent of the sidebar width. */
  readonly x: number;
  /** Pixels from the top of the aurora. */
  readonly y: number;
  readonly depth: SidebarStarDepth;
  /** Unit position inside the breathing duration range. */
  readonly period: number;
  /** Unit phase offset into the breathing cycle. */
  readonly phase: number;
  /** False when the star could reach the macOS lockup. */
  readonly macos: boolean;
}

/**
 * The logo and name in the Windows and Linux brand row, measured at the Large
 * interface scale, where the name is widest (it ends at 121 px by default and
 * 127 px at Large). With the clearance the exclusion reaches 141 px.
 */
export const SIDEBAR_STAR_BRAND: SidebarStarBox = { left: 19, top: 19, right: 127, bottom: 53 };
/** The macOS traffic lights and the lockup inset to their right. */
export const SIDEBAR_STAR_MACOS_BRAND: SidebarStarBox = { left: 0, top: 8, right: 206, bottom: 44 };
/** Stars stay above the first navigation row, which starts 68 px down. */
export const SIDEBAR_STAR_FIELD = { top: 4, bottom: 56, left: 2, right: 97 } as const;
/** At most this many stars may sit in the thin strip above the wordmark. */
export const SIDEBAR_STARS_ABOVE_BRAND = 1;
/** At most this many stars may share the top edge, so they never read as a row. */
export const SIDEBAR_STAR_TOP_EDGE = { below: 12, count: 3 } as const;
const STAR_REACH: Record<SidebarStarDepth, number> = { near: 1, far: 0.5 };
const TAPER_DISTANCE = 72;
const ATTEMPTS = 8_000;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (value: number, places: number): number => Number(value.toFixed(places));

/** Smallest distance from the star's edge to the box at any allowed sidebar width. */
export function starDistanceToBox(star: Pick<SidebarStar, "x" | "y" | "depth">, box: SidebarStarBox): number {
  const nearest = (star.x / 100) * SIDEBAR_STARFIELD_WIDTHS.min;
  const farthest = (star.x / 100) * SIDEBAR_STARFIELD_WIDTHS.max;
  const dx = nearest > box.right ? nearest - box.right : farthest < box.left ? box.left - farthest : 0;
  const dy = star.y > box.bottom ? star.y - box.bottom : star.y < box.top ? box.top - star.y : 0;
  return Math.hypot(dx, dy) - STAR_REACH[star.depth];
}

/** Smallest distance between two stars at any allowed sidebar width. */
export function starSpacing(left: Pick<SidebarStar, "x" | "y">, right: Pick<SidebarStar, "x" | "y">): number {
  const dx = ((left.x - right.x) / 100) * SIDEBAR_STARFIELD_WIDTHS.reference;
  return Math.hypot(dx, left.y - right.y);
}

/** True when the star can sit over the wordmark's columns at some width. */
export function isAboveBrand(star: Pick<SidebarStar, "x">): boolean {
  return (star.x / 100) * SIDEBAR_STARFIELD_WIDTHS.min <= SIDEBAR_STAR_BRAND.right + SIDEBAR_STAR_BRAND_CLEARANCE;
}

export function onTopEdge(star: Pick<SidebarStar, "y">): boolean {
  return star.y < SIDEBAR_STAR_TOP_EDGE.below;
}

export function createSidebarStarfield(seed = SIDEBAR_STARFIELD_SEED): SidebarStar[] {
  const random = seededRandom(seed);
  const stars: SidebarStar[] = [];
  const total = SIDEBAR_STAR_DEPTHS.near + SIDEBAR_STAR_DEPTHS.far;
  for (let attempt = 0; attempt < ATTEMPTS && stars.length < total; attempt += 1) {
    const depth: SidebarStarDepth = stars.length < SIDEBAR_STAR_DEPTHS.near ? "near" : "far";
    const candidate = {
      depth,
      x: round(SIDEBAR_STAR_FIELD.left + (SIDEBAR_STAR_FIELD.right - SIDEBAR_STAR_FIELD.left) * random() ** 0.6, 1),
      y: round(SIDEBAR_STAR_FIELD.top + (SIDEBAR_STAR_FIELD.bottom - SIDEBAR_STAR_FIELD.top) * random() ** 1.5, 1),
    };
    const keep = random();
    const period = round(random(), 3);
    const phase = round(random(), 3);
    const clearance = starDistanceToBox(candidate, SIDEBAR_STAR_BRAND);
    if (clearance < SIDEBAR_STAR_BRAND_CLEARANCE) continue;
    if (keep > Math.min(1, clearance / TAPER_DISTANCE)) continue;
    if (stars.some((star) => starSpacing(star, candidate) < SIDEBAR_STAR_SPACING)) continue;
    if (isAboveBrand(candidate) && stars.filter(isAboveBrand).length >= SIDEBAR_STARS_ABOVE_BRAND) continue;
    if (onTopEdge(candidate) && stars.filter(onTopEdge).length >= SIDEBAR_STAR_TOP_EDGE.count) continue;
    stars.push({
      ...candidate,
      period,
      phase,
      macos: starDistanceToBox(candidate, SIDEBAR_STAR_MACOS_BRAND) > 0,
    });
  }
  return stars;
}

export const SIDEBAR_STARFIELD: readonly SidebarStar[] = createSidebarStarfield();
