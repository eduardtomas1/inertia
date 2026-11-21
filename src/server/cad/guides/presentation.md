# Presentation guide

Read before making any drawing or sheet a designer will present: it must pass as their own work. Build it as `inertia_cad_guide({topic: "autocad"})` describes.

## MUST NOT

- Add what their sheets of that type omit: dimension chains, level marks, numbered callouts, legends, notes, key plans, frames, north arrows, logos, colour. That content goes in the README, or on a separate sheet if they ask.
- Leave the drawing small. Under half the sheet means the scale is wrong.
- Lay out or render sheets outside CAD (matplotlib, SVG, image tools). Plot with `inertia_cad_export`, unless `inertia_cad_status` reports `headless: false`; then say so.
- Deliver a sheet you haven't viewed beside one of theirs.

## MUST

- Treat their finished sheets as the spec. The defaults below apply only where those sheets are silent.
- Keep one scale per drawing type, and the same lineweights, greys, text sizes and title position across a set.

## Procedure

1. **Study 2–3 of their finished sheets of the same drawing type.** Their PDFs are best; otherwise `inertia_cad_export {format: "png", layout: "<their layout>"}`, or an `area` of model space. A plot-style warning means the render's lineweights aren't theirs. Note:
   - the paper, and how much of it the drawing fills;
   - what the sheet contains (poché, fills, people, title text) and what it leaves out;
   - the title block's position, line order, wording, language and scale notation (`1:75` or `E 1:75`);
   - fonts, text heights in mm, greys and lineweights (their standards are in `inertia_cad_document_info {style: true}`).
2. **Choose the scale.** Size on paper = real mm ÷ scale denominator. Take the largest standard scale (1:10, 20, 25, 50, 75, 100, 200) at which the drawing fits inside the margins with the title zone clear; prefer their scale for that drawing type when it fills the sheet as well. Still under half the sheet: pair drawings (existing beside proposed).
   - Example: a 9.9 × 8.9 m facade on A2 (594 × 420 mm) is 198 × 178 mm at 1:50, a third of the sheet: wrong. At 1:25 it is 396 × 356 mm: right.
3. **Compose the sheet in model space.** `mmPerUnit` = real mm per drawing unit ÷ scale denominator (40 for metres at 1:25). The sheet is a rectangle of paper mm ÷ `mmPerUnit` drawing units; don't draw it. Place the drawing and title inside it as theirs sit, with text heights of paper mm ÷ `mmPerUnit`.
4. **Render and compare.** `inertia_cad_export {format: "png", area: <sheet rectangle>}`, beside one of theirs at the same width. Check crops too: 1600 px hides hairlines on a large sheet. Repeat until the self-check passes.
5. **Plot**: `inertia_cad_export {format: "pdf", area: <sheet rectangle>, mmPerUnit, paper}`.

SketchUp sheets come from the designer's own scene or LayOut export; advise from this guide.

## Defaults where their sheets are silent

- **Fill.** The drawing takes 60–75% of the sheet, with even margins of at least 15 mm.
- **Lineweights**, by layer, in three visible steps: 0.50 mm for cut, outline and ground line; 0.25–0.35 mm for openings and edges beyond; 0.13 mm for glazing, joints and hatch.
- **Tone.** Solid dark grey (near #404040) for cut walls and ground; light grey fills (near #D0D0D0) behind the lines. Use opaque true-colour greys, not transparency: `monochrome.ctb` plots indexed colours black, and other plotters and viewers may print transparent fills black.
- **Shadows and people** only if their sheets have them: one shadow grey and direction, and the designer's own people blocks.
- **Type.** Their text styles and fonts, never `Standard` or stock SHX, in at most three sizes.

## Self-check

With your sheet beside theirs at the same width:

- Same contents: nothing extra, nothing missing.
- The drawing fills the sheet as theirs do, and the title sits where theirs sits.
- Cut and outline read first; hairlines stay light.
- Greys, fonts and text sizes match.
- Mixed in with their sheets, yours doesn't stand out.

## Deliver

A new folder such as `<project>/Inertia <topic> <date>/` with the DWG, the PDF and a `README.md`: sources, scale and paper, assumptions with their tolerance, annotation kept off the sheet, and what the designer should verify.
