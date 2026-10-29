# Custom agent marks

Six cute standing characters with floating logo heads and role-specific outfits.
The heads are 30% smaller than the initial themed study. Every mark has a
transparent 256×256 WebP for dark and light tiles (quality 90).

| Stable ID | Character | Files |
| --- | --- | --- |
| runner | Workflow planner — sturdy vest, linked checklist and floating numbers | [dark](runner-dark.webp) · [light](runner-light.webp) |
| scout | Investigator — trench coat, glasses and magnifier | [dark](scout-dark.webp) · [light](scout-light.webp) |
| guard | Marketing — seafoam cardigan, phone and megaphone pin | [dark](guard-dark.webp) · [light](guard-light.webp) |
| builder | Builder / Fixer — denim overalls, tool belt and wrench | [dark](builder-dark.webp) · [light](builder-light.webp) |
| scribe | Writer — mulberry cardigan, open notebook and pen | [dark](scribe-dark.webp) · [light](scribe-light.webp) |
| spark | Creative — clay apron, sketchbook, pencil and pocket brush | [dark](spark-dark.webp) · [light](spark-light.webp) |

IDs remain unchanged so saved agents and exported files continue to resolve.
The picker labels describe the new characters. Outfit colours are baked in;
the agent's chosen accent still colours its surrounding tile.

## Provenance and regeneration

Editable Blender scenes, studio previews and transparent source renders live in
[`source-assets/custom-agent-marks`](../../../../../source-assets/custom-agent-marks/README.md).
The shared generator uses the seven-vertex outline from `inertia-logo.svg`.
The former Roman worker is retained only as an archived study.

After rebuilding the six models using that README, export and review:

```sh
python3 scripts/custom-agent-marks/review-themed-family.py
python3 scripts/custom-agent-marks/export-themed-marks.py
```

The exporter uses `frame-renders.py`: alpha bounds above 8, a 7% margin,
premultiplied-alpha Lanczos resizing, then WebP at quality 90. Both variants use
the same source geometry and camera. Light images use contrast 1.1 without
highlight lift; dark images use brightness 1.06. This keeps the coloured outfits
readable. Review sheets are written to `source-assets/custom-agent-marks/app-review`.
The original `render-marks.py` remains only for reproducing the retired runner set.

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
| 18 | message badge | 1 | 16 | no |
| 20 | composer chip, `/calling` rows, preset chips | 1 | 18 | no |
| 24 | reserved | 1 | 22 | no |
| 32 | empty-state hero | 2 | 28 | yes |
| 36 | call block header, settings rows | 2 | 32 | yes |
| 40 | mark gallery options | 2 | 36 | yes |
| 48 | reserved | 4 | 40 | yes |
| 64 | editor preview | 4 | 56 | yes |

Below a 28-pixel figure box the props do not read, and the mark is simply the
floating-cursor character. The agent's name and accent always sit beside the mark, so the UI
never relies on the figure alone to show a role.
