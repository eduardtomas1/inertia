# Custom agent marks

Six porcelain figures that a custom agent can wear instead of a symbol or an
uploaded PNG. Each mark is the Inertia runner from the app mascot, posed with one
graphite prop that hints at a role. Every mark has a dark-theme and a light-theme
render: 256 × 256 pixels, transparent, lossy WebP at quality 90.

| Mark | Prop | Files |
| --- | --- | --- |
| Runner | none, a plain forward stride | [dark](runner-dark.webp) · [light](runner-light.webp) |
| Scout | open magnifying ring beside the head | [dark](scout-dark.webp) · [light](scout-light.webp) |
| Guard | round shield with a porcelain rim | [dark](guard-dark.webp) · [light](guard-light.webp) |
| Builder | open-jaw wrench over the shoulder | [dark](builder-dark.webp) · [light](builder-light.webp) |
| Scribe | pen held in a writing gesture | [dark](scribe-dark.webp) · [light](scribe-light.webp) |
| Spark | lightning shape behind the rear foot | [dark](spark-dark.webp) · [light](spark-light.webp) |

The body is porcelain white and the props are graphite; no accent colour is baked
in. The agent's accent comes from the tile behind the figure. Dark renders carry
a stronger rim light; light renders use a lower rim and a warmer fill. All six share
one orthographic framing, so the figure never jumps when you switch marks.

## Provenance

The marks are new poses of the mascot rig in
[`source-assets/mascot/inertia-mascot-pickup.blend`](../../../../../source-assets/mascot/README.md):
the same continuous runner mesh, corrective smoothing, cursor shells, graphite
midframe and materials. The props are simple bevelled meshes added at render time.
The source file is read only; the render script never saves it.

## Regeneration

Use Blender 5.2 with `blender-run`, plus system Python 3 with Pillow (WebP support).
Render into a scratch folder, then copy the twelve WebPs into this folder:

```sh
blender-run --threads 2 source-assets/mascot/inertia-mascot-pickup.blend \
  scripts/custom-agent-marks/render-marks.py -- --output /tmp/agent-marks
scripts/custom-agent-marks/import-renders.sh /tmp/agent-marks
```

`render-marks.py` renders with Cycles on the CPU (two threads, 24 samples, a fixed
seed, denoised) and waits while the machine is busy. It also writes
`contact-sheet.png` and `readability.png` (each mark at 32 and 20 pixels on both
tile colours) for review; those stay in the scratch folder. Pass `--only runner,scout`
to render a subset, or `--inspection` for the AgX view transform. The import script
copies only the twelve `<mark>-<theme>.webp` files and stops if one is missing.

## Renderer use

`CustomAgentAvatar` renders a mark as an empty figure span inside the tile, never
an `img`. `CustomAgentAvatar.css` maps each `data-mark` value to its file once per
theme through the `--agent-mark` custom property: the dark file by default, the
light file under `:root[data-theme="light"]`. A CSS background is fetched only
when an element first needs it, so light files are never loaded while the app is
dark. The figure box is sized by CSS before the image arrives, so nothing shifts.
The build never inlines these files into the stylesheet.

Draw with `background-size: contain`, centred, and the default `image-rendering`.
Never use `pixelated`; that rule belongs to the pixel mascot. Keep one 256-pixel
file per mark and theme: Chromium's mipmaps make a smaller derivative look
identical at every tile size.

The tile draws the soft contact ellipse under the feet, so the renders must not
bake one in; that lets the figure lift off the ground while an agent runs.

| Tile | Where | Inset | Figure box | Shadow |
| ---: | --- | ---: | ---: | --- |
| 18 | message badge | 0 | 18 | no |
| 20 | composer chip, `/calling` rows, preset chips | 0 | 20 | no |
| 24 | reserved | 0 | 24 | no |
| 32 | empty-state hero | 2 | 28 | yes |
| 36 | call block header, settings rows | 2 | 32 | yes |
| 40 | mark gallery options | 2 | 36 | yes |
| 48 | reserved | 4 | 40 | yes |
| 64 | editor preview | 4 | 56 | yes |

Below a 28-pixel figure box the props do not read, and the mark is simply the
Inertia runner. The agent's name and accent always sit beside the mark, so the UI
never relies on the figure alone to show a role.
