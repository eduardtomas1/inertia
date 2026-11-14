import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

export const COMPOSER_FOLD_ORDER = ["branch", "mode", "access", "speed", "reasoning"] as const;

export type ComposerFoldKey = (typeof COMPOSER_FOLD_ORDER)[number];

export function composerFoldOrder(attention: readonly ComposerFoldKey[]): readonly ComposerFoldKey[] {
  if (attention.length === 0) return COMPOSER_FOLD_ORDER;
  return [
    ...COMPOSER_FOLD_ORDER.filter((key) => !attention.includes(key)),
    ...COMPOSER_FOLD_ORDER.filter((key) => attention.includes(key)),
  ];
}

export interface ComposerChipFolding {
  folded: ReadonlySet<ComposerFoldKey>;
  exhausted: boolean;
}

export interface ComposerFoldMeasurement {
  present: readonly ComposerFoldKey[];
  folded: number;
  spill: number;
  slack: number;
  widths: ReadonlyMap<ComposerFoldKey, number>;
  gap: number;
  freedWhenUnfolded: number;
}

export function nextComposerFoldCount({
  present,
  folded,
  spill,
  slack,
  widths,
  gap,
  freedWhenUnfolded,
}: ComposerFoldMeasurement): number {
  const count = Math.min(Math.max(folded, 0), present.length);
  if (spill > 0.5) return Math.min(count + 1, present.length);
  if (count === 0) return 0;
  const width = widths.get(present[count - 1]!);
  if (width === undefined) return count;
  const freed = count === 1 ? freedWhenUnfolded : 0;
  return slack + freed >= width + gap + 1 ? count - 1 : count;
}

function foldKey(element: HTMLElement): ComposerFoldKey | null {
  const key = element.dataset.composerFold;
  return COMPOSER_FOLD_ORDER.find((candidate) => candidate === key) ?? null;
}

function shown(element: Element): boolean {
  return element.getClientRects().length > 0;
}

function sameKeys(first: readonly ComposerFoldKey[], second: readonly ComposerFoldKey[]): boolean {
  return first.length === second.length && first.every((key, index) => key === second[index]);
}

const NOTHING_FOLDED: readonly ComposerFoldKey[] = [];

export function useComposerChipFolding(
  railRef: RefObject<HTMLElement | null>,
  attention: readonly ComposerFoldKey[],
): ComposerChipFolding {
  const order = useMemo(() => composerFoldOrder(attention), [attention]);
  const [state, setState] = useState<{ folded: readonly ComposerFoldKey[]; present: readonly ComposerFoldKey[] }>({
    folded: NOTHING_FOLDED,
    present: NOTHING_FOLDED,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const widths = useRef(new Map<ComposerFoldKey, number>());

  const measure = useCallback((synchronous: boolean): void => {
    const rail = railRef.current;
    const options = rail?.querySelector<HTMLElement>(":scope > .composer-options");
    if (!rail?.isConnected || !options || !shown(options)) return;
    const chips = [...options.querySelectorAll<HTMLElement>("[data-composer-fold]")];
    const present = order.filter((key) => chips.some((chip) => foldKey(chip) === key));
    for (const chip of chips) {
      const key = foldKey(chip);
      if (!key || !shown(chip)) continue;
      const width = chip.getBoundingClientRect().width;
      if (width > 0) widths.current.set(key, width);
    }
    const current = stateRef.current.folded;
    let count = 0;
    while (count < present.length && current.includes(present[count]!)) count += 1;
    const optionsBounds = options.getBoundingClientRect();
    const railStyle = getComputedStyle(rail);
    const railGap = Number.parseFloat(railStyle.columnGap) || 0;
    const following = [...rail.children]
      .slice([...rail.children].indexOf(options) + 1)
      .find(shown);
    const end = following
      ? following.getBoundingClientRect().left - railGap
      : rail.getBoundingClientRect().right - (Number.parseFloat(railStyle.paddingRight) || 0);
    const gap = Number.parseFloat(getComputedStyle(options).columnGap) || 0;
    const overflow = options.querySelector<HTMLElement>(":scope > .composer-more-control");
    const pinned = overflow
      ? getComputedStyle(overflow).getPropertyValue("--composer-more-pinned").trim() === "1"
      : false;
    const freedWhenUnfolded = overflow && shown(overflow) && !pinned
      ? overflow.getBoundingClientRect().width + gap
      : 0;
    const contentRight = Math.max(
      optionsBounds.left,
      ...[...options.children].filter(shown).map((child) => child.getBoundingClientRect().right),
    );
    const spill = contentRight - optionsBounds.right;
    const slack = end - optionsBounds.right;
    const candidate = spill <= 0.5 && count > 0
      ? chips.find((chip) => foldKey(chip) === present[count - 1])
      : undefined;
    if (candidate?.dataset.folded === "true") {
      const shrink = candidate.style.flexShrink;
      candidate.style.flexShrink = "0";
      delete candidate.dataset.folded;
      const width = candidate.getBoundingClientRect().width;
      candidate.dataset.folded = "true";
      candidate.style.flexShrink = shrink;
      if (width > 0) widths.current.set(present[count - 1]!, width);
    }
    const next = nextComposerFoldCount({
      present,
      folded: count,
      spill,
      slack,
      widths: widths.current,
      gap,
      freedWhenUnfolded,
    });
    const folded = present.slice(0, next);
    if (sameKeys(folded, current) && sameKeys(present, stateRef.current.present)) return;
    const update = (): void => setState({ folded, present });
    if (synchronous) flushSync(update);
    else update();
  }, [order, railRef]);

  useLayoutEffect(() => {
    measure(false);
  }, [measure, state]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    const options = rail?.querySelector<HTMLElement>(":scope > .composer-options");
    if (!rail || !options) return;
    const observed = new Set<Element>();
    const resize = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => measure(true))
      : null;
    const observe = (): void => {
      if (!resize) return;
      const targets = new Set<Element>([
        rail,
        ...rail.children,
        ...options.querySelectorAll("[data-composer-fold], .model-chooser-anchor"),
      ]);
      for (const element of observed) {
        if (targets.has(element)) continue;
        observed.delete(element);
        resize.unobserve(element);
      }
      for (const element of targets) {
        if (observed.has(element)) continue;
        observed.add(element);
        resize.observe(element);
      }
    };
    observe();
    const mutation = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          observe();
          measure(false);
        })
      : null;
    mutation?.observe(options, { childList: true, subtree: true, characterData: true });
    mutation?.observe(rail, { childList: true });
    return () => {
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [measure, railRef]);

  const folded = useMemo(() => new Set(state.folded), [state.folded]);
  return {
    folded,
    exhausted: state.present.length === 0 || state.folded.length >= state.present.length,
  };
}
