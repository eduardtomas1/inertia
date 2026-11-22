# AutoCAD guide

Read before reading, drawing or editing a designer's AutoCAD work. For anything they will present, also read `inertia_cad_guide({topic: "presentation"})`.

## MUST NOT

- Reach AutoCAD or their drawings except through the `inertia_cad_*` tools: no COM, `SendCommand`, LISP, scripts or accoreconsole of your own. Parse only DXFs you or `inertia_cad_export` wrote.
- Save, close or undo in their session, or build new work inside their drawing.
- Draw on `Defpoints`, or on `0` outside block definitions.
- Give objects their own colour, linetype or lineweight unless asked; properties stay ByLayer.
- Scale geometry to fit a sheet: model space is 1:1.

## MUST

- Look before reasoning and after every change: `inertia_cad_export` `png` for saved files, `inertia_cad_capture_view {bbox}` for applied, unsaved edits.
- Say so when what you read is older than the open drawing (`liveUnsaved`, or `modified: true` in `inertia_cad_status`).
- On `READ_MODIFIED_DRAWING`, stop all calls on that drawing and tell the designer.

## Procedure

1. `inertia_cad_status`; fix what `hint` names.
2. `inertia_cad_document_info` once per drawing, with `style: true` before drawing.
3. Then:
   - **Understand it**: `inertia_cad_export` `png` of an `area` (about 1600 px wide; a smaller `area` zooms), or `dxf` to your own `destination` plus ezdxf for all the geometry. `inertia_cad_query_objects` is for filtered lookups.
   - **A change they asked for, in their drawing**: "Editing the open drawing".
   - **A new drawing or sheet, new styles, or more than a few batches**: "Building a new drawing".

## Reading their drawing

- **Units.** `insUnits` is often wrong: drawings marked mm are often in metres. Measure a door leaf (0.7–1.0 m) or a dimension's `measurement` for the real mm per unit: 1000, 10 or 1.
- **Plot styles.** With a `.ctb` in `layouts[].plotStyleTable`, colour sets the printed lineweight: use the colour of their layer with that role.
- **Text.** Copy style and height from their `TEXT`/`MTEXT`, and dimensions from `dimStyles.active`.
- **Xrefs** aren't listed, and relative ones are missing from exports (`warnings`). If content looks missing, tell the designer.

## Editing the open drawing

- There is no dialog: the user's request in this conversation is the approval, even while the designer is working. Apply only that: preview, tell the user what will change, apply, and `inertia_cad_capture_view {bbox}` on the preview's area before and after.
- Pass `layer` on every `add_*` and `insert_block`; `add_text` uses `current.textStyle`.
- Prefer existing layers; ask before `acad.create_layer`, which sets only a colour index.
- `NESTED_TARGET` and `LOCKED` are the designer's call: report them without pressing to explode or unlock.
- `HOST_BUSY`, `INACTIVE_DOCUMENT`, `HOST_OFFLINE`, `UNDO_DISABLED`: nothing was sent; once the cause is fixed, apply the same `proposalId`. `TARGET_CHANGED`, `PROPOSAL_EXPIRED`: read and preview again.

## Furniture and layout edits

- **Extents, not insertion points.** An insertion point can sit a metre or more from the visible block: query with `bbox: true` and measure from extents.
- **Clearances.** Clear passages are typically 0.6–0.9 m: about 0.9 m on main routes, 0.6 m between furniture. The designer's own drawings override these.
- **Alignment.** Read the wall's angle from its geometry and `set_rotation` to match. Line pieces up with rug or area edges.
- **Rotate, then move.** Rotating shifts the extents, so read `bbox` again before computing the move.
- **Reuse.** `copy` or `insert_block` the designer's existing blocks rather than drawing new furniture.
- **Small batches**, each captured before and after.

## Building a new drawing

1. Write a DXF with ezdxf in their real drawing unit, in a new folder: outputs land beside their `source`.
2. Use their layer, text style and dim style names exactly; the build swaps in their definitions. Copy reused blocks from a `dxf` export, make repeats blocks and dimensions real dimensions, and run `doc.audit()`.
3. `inertia_cad_export {source: "<your.dxf>", format: "dwg", template: "<their drawing>"}`. Only model space carries over, so compose sheets there.
4. Render as `png` and say where colours, lineweights or fonts differ from theirs.

## Limits

- New ops and parameters from a Inertia update need a fresh agent session. If one named here (`style`, `within`, `insert_block`) is missing, ask for one; never fall back to COM or scripts.
- `headless: false` in `inertia_cad_status`: no `inertia_cad_export`. Use `inertia_cad_query_objects` and `inertia_cad_capture_view {bbox}`, and say what you couldn't check.
