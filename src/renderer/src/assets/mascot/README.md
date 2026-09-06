# Inertia pixel mascot

The final pixel-art mascot: a white, cursor-headed stick figure based on Inertia's
own logo in `resources/icon.svg`. All four states share a 96 × 96 transparent
canvas, a fixed 12-color palette and 12 fps timing. Animated WebP files use
lossless encoding to retain crisp pixel edges. PNGs are the matching still frames.

| State | Animation | Still frame | Duration | Frames |
| --- | --- | --- | ---: | ---: |
| Idle | [idle.webp](idle.webp) | [idle.png](idle.png) | 4 s | 48 |
| Thinking | [thinking.webp](thinking.webp) | [thinking.png](thinking.png) | 4 s | 48 |
| Idea | [idea.webp](idea.webp) | [idea.png](idea.png) | 3 s | 36 |
| Working | [working.webp](working.webp) | [working.png](working.png) | 4 s | 48 |

`manifest.json` records the palette, dimensions and per-state timing. Every
animation loops; Idea also returns to its starting pose. Thinking includes the
three moving thought dots, Idea the golden bulb, and Working the adjusted laptop.

## Renderer use

These are renderer assets, following the same placement and Vite import convention
as the provider icons. Import only the states a component needs, using `?no-inline`
to emit image files rather than encoding them into JavaScript:

```ts
import idleAnimation from "@/assets/mascot/idle.webp?no-inline";
import idlePoster from "@/assets/mascot/idle.png?no-inline";
```

Display with a native `img`, explicit width and height, and `image-rendering: pixelated`.
Use an integer multiple of 96 pixels for enlarged previews. Preserve the shared
canvas and aspect ratio when switching states so the mascot does not jump.

Use the matching PNG for `prefers-reduced-motion: reduce`, when paused, and while
the companion is inactive or hidden. CSS cannot pause an animated WebP: switch its
source to the still frame. Use empty alternative text when the mascot is decorative;
otherwise describe the actual app state it represents. Drive state changes from
real app activity when connecting the companion to the interface.

The optional desktop overlay uses this final pixel pack. Its status mapping lives
in the runtime, and its image selection lives in `../../mascot/assets.ts`. No 3D
models, rendering libraries, alternate studies or preview application are needed
at runtime.
