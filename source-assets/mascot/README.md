# Editable mascot pickup

`inertia-mascot-pickup.blend` is a copy of the original **Inertia study 06**
model with an additional `Pickup` action on its existing 18-bone rig. It retains
the original meshes, skin weights, porcelain cursor shells, graphite midframe,
materials, and Idle / Thinking / Idea / Working actions. Pickup lifts the figure,
spreads its shoulders, bends its knees, and adds a restrained hanging sway.

Provenance: the user's `Desktop/InertiaMascot/inertia-mascot-animated.blend`,
created by `source/build-mascot-v6.py` in that asset study. Original SHA-256:
`4bd89f4014516631724f4e502247f76d9250e73a82d3c77ee031e89437d2e238`.
The original was read without modification. This copy is an authoring asset and
is excluded from the application package by its existing `out/**/*` allowlist.

Regenerate with Blender 5.2, Python 3 + Pillow, and libwebp's `img2webp` on PATH:

```sh
blender --background --python scripts/mascot/pose-pickup.py -- \
  --source source-assets/mascot/inertia-mascot-pickup.blend \
  --output /tmp/inertia-pickup
python3 scripts/mascot/encode-pickup.py /tmp/inertia-pickup
```

The pose script works on either the original study or this copy, replaces only
the Pickup action, writes an editable Blender copy and an animated GLB to the
output directory, and renders 24 transparent frames at 12 fps. The second script
uses the existing 96 × 96 canvas, 12-color palette, one-pixel outline, and lossless
WebP encoding. These tools are for asset authoring, not runtime dependencies.

The app displays the resulting PNG/WebP using native images. A 180ms opacity
transition returns to the **latest** activity on release. The activity bubble
continues updating throughout pickup. Paused, hidden and reduced-motion surfaces
use static posters, and an elapsed completion cue is never replayed on drop.
