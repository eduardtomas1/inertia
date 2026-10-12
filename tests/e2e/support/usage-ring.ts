import { expect, type Locator } from "@playwright/test";

export async function expectContextRingFitsItsNumber(ring: Locator): Promise<void> {
  const geometry = await ring.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const label = element.querySelector<HTMLElement>(".usage-context-ring-label")!;
    const value = element.querySelector<SVGCircleElement>(".usage-context-ring-value")!;
    const track = element.querySelector<SVGCircleElement>(".usage-context-ring-track")!.getBoundingClientRect();
    const stroke = Number.parseFloat(getComputedStyle(value).strokeWidth);
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const labelStyle = getComputedStyle(label);
    const fit = (text: string) => {
      const probe = label.cloneNode() as HTMLElement;
      probe.textContent = text;
      label.after(probe);
      label.hidden = true;
      const range = document.createRange();
      range.selectNodeContents(probe);
      const box = range.getBoundingClientRect();
      probe.remove();
      label.hidden = false;
      return {
        halfWidth: box.width / 2,
        offsetX: Math.abs(box.left + box.width / 2 - centerX),
        offsetY: Math.abs(box.top + box.height / 2 - centerY),
      };
    };
    return {
      outerGap: bounds.width / 2 - (track.width / 2 + stroke / 2),
      innerRadius: track.width / 2 - stroke / 2,
      label: {
        fontSize: labelStyle.fontSize,
        fontWeight: labelStyle.fontWeight,
        numeric: labelStyle.fontVariantNumeric,
        letterSpacing: labelStyle.letterSpacing,
      },
      fits: ["15", "88", "100"].map(fit),
    };
  });
  expect(geometry.outerGap).toBeGreaterThanOrEqual(0);
  expect(geometry.outerGap).toBeLessThanOrEqual(0.5);
  expect(geometry.label).toEqual({
    fontSize: "12px",
    fontWeight: "500",
    numeric: "tabular-nums",
    letterSpacing: "normal",
  });
  for (const fit of geometry.fits) {
    expect(fit.halfWidth).toBeLessThan(geometry.innerRadius);
    expect(fit.offsetX).toBeLessThanOrEqual(0.5);
    expect(fit.offsetY).toBeLessThanOrEqual(0.5);
  }
}
