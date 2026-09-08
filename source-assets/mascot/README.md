# Editable mascot pickup

`inertia-mascot-pickup.blend` is an editable copy of the original **Inertia study
06** model. It retains all 25 original meshes, the 18-bone rest skeleton, the
porcelain cursor shells and graphite midframe, materials, and Idle / Thinking /
Idea / Working actions.

The body has broader, normalized skin weights around its elbows, knees and shared
hip junction, plus a non-destructive corrective smoothing modifier. This removes
the pinched, rigid-looking bends from the first pickup pose. The original geometry
and the user's source files are unchanged.

Two new rig actions provide the movement:

- **PickupLift:** a 400 ms lift, with the body leading its arms and feet. It can
  reverse from any frame on an early release, so quick clicks do not snap into a
  fully suspended pose. Its final bone transforms exactly match the loop start.
- **Pickup:** a closed two-second suspended loop. Slightly asymmetric knees,
  separated feet, stable elbow/knee bend planes and delayed limb motion preserve
  a readable silhouette at the normal small mascot size.

Provenance: the user's `Desktop/InertiaMascot/inertia-mascot-animated.blend`,
created by `source/build-mascot-v6.py` in that asset study. Original SHA-256:
`4bd89f4014516631724f4e502247f76d9250e73a82d3c77ee031e89437d2e238`.
This separate authoring copy is excluded from the application package by the
existing `out/**/*` allowlist.

## Regeneration and inspection

Use Blender 5.2, Python 3 + Pillow, and libwebp's `img2webp` on PATH:

```sh
blender --background --threads 2 --python scripts/mascot/pose-pickup.py -- \
  --source source-assets/mascot/inertia-mascot-pickup.blend \
  --output /tmp/inertia-pickup
python3 scripts/mascot/encode-pickup.py /tmp/inertia-pickup
blender --background --python-exit-code 1 --python scripts/mascot/verify-pickup.py -- \
  --original /path/to/original.blend \
  --candidate /tmp/inertia-pickup/inertia-mascot-pickup.blend
```

The pose script works on either the original study or this copy, writes the
editable Blender file and transparent captures, and produces front, side, back,
three-quarter and ordinary-state inspection renders. Add `--preview-only` to
skip the runtime frame renders. The `.blend` is the authoritative model: its
corrective deformation is evaluated before each sprite capture.
The verification script compares the original geometry, rest skeleton and material
colors, then checks skin normalization and lift/loop bone-transform continuity.

The encoder uses the existing 96 × 96 pixel grid, 12-color palette, one-pixel
outline and lossless WebP encoding. The editable model and inspection renders
retain AgX studio highlight detail; the pixel captures use Standard display-referred
color to match the existing porcelain whites. The lift strip contains 13 poses and the loop has 48 frames
at 24 fps. These are authoring tools, not runtime dependencies.

The app uses native images and a reversible CSS sprite transition, with no
JavaScript frame loop or WebGL. Paused, hidden and reduced-motion surfaces use
posters immediately. The activity bubble stays current during pickup; releasing
returns to the latest activity and never restarts an elapsed completion cue.

[Multi-angle model inspection](../../docs/screenshots/mascot/mascot-rig-inspection.png)
and [actual Electron motion capture](../../docs/screenshots/mascot/mascot-motion.webp)
are included with the PR evidence.
