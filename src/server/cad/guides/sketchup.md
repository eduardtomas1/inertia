# SketchUp guide

Read before reading or editing a designer's open SketchUp model. `inertia_cad_export` and `style` are AutoCAD-only.

## MUST NOT

- Reach SketchUp or the designer's `.skp` files any way but the `inertia_cad_*` tools: no Ruby, plugins or scripts.
- Save, close or undo in their session.
- Erase without explicit consent for those exact objects. Erasing an edge deletes its faces. Prefer `skp.set_hidden` or a tag, which are reversible.
- Tidy tags, names, nesting, hidden state or materials nobody asked about.
- Tag faces or edges. Raw geometry stays Untagged; only groups and components carry tags.
- Read while an apply is `pending`. The approval dialog blocks SketchUp, so reads time out; call `inertia_cad_apply_changes` again instead.

## MUST

- Look before reasoning and after every change with `inertia_cad_capture_view`. A box on a hidden tag won't show.
- Reuse their tags, materials and naming; create one only when none fits.
- Name and tag every box you add.
- Speak to the designer in their `displayUnits`. The tools always use mm, in world axes.

## Procedure

1. `inertia_cad_status {app: "sketchup"}`. Fix what `hint` names.
2. `inertia_cad_document_info` once. Its tags, scenes, materials and component definitions are the designer's system.
3. `inertia_cad_get_selection`. A non-empty `editingInside` means a group is open for editing: before you edit, ask the designer to close it, because entering or leaving one makes erase previews stale.
4. `inertia_cad_query_objects` for lookups (`fields: "compact"` on big models).
5. If reading answers the request, stop there.
6. To edit: preview, tell the designer what will change, apply, then capture to verify.

## Editing the model

- **Instances.** Editing a top-level instance touches only that instance, and `skp.rename` renames the instance, not its definition. Anything inside a definition used more than once (copied groups included) is refused with `SHARED_DEFINITION`: target the top-level object, or ask the designer to Make Unique.
- **Materials.** On a group or component, `skp.set_material` colours only its Default-material faces. On a face, it paints the front only.
- **Boxes.** `skp.add_box` always makes a top-level group, extruded up +Z from its minimum corner `originMm`. Keep every side at least 1 mm; SketchUp drops smaller faces.
- **Moves and names** work only on groups and components.
- `LOCKED` is the designer's decision: report it, and don't press for unlocking.
- `INACTIVE_DOCUMENT` means nothing was sent: once the model is in front, apply the same `proposalId`. `TARGET_CHANGED` or `PROPOSAL_EXPIRED`: read and preview again.

## Limits

- **View.** No camera, scene or style control. A capture is the current view, never larger than the viewport. Ask the designer to click a scene tab, then capture; the returned `scene` is the last tab clicked, and the camera may have moved since.
- **Scenes.** A scene that saves Hidden Objects can undo `skp.set_hidden` when clicked. Use tags for visibility that differs per scene, and ask the designer to update the scenes they want changed.
- **Modelling beyond boxes.** No faces, arcs, components, text, dimensions, textures, Make Unique, explode or purge. Describe the steps for the designer.
- **Sheets and PDFs** come from the designer's own SketchUp or LayOut export; for what a sheet should look like, read `inertia_cad_guide({topic: "presentation"})`.
- **LayOut** reads the saved `.skp`, so edits reach its viewports only after the designer saves and updates the reference. A `inertia_cad_save_copy` file is a different file.
- A parameter named here is missing (`fields`, `within`): your schemas are stale. Ask for a fresh session; never fall back to Ruby or scripts.
