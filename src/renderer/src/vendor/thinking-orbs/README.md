# thinking-orbs engine provenance

These modules are the pure geometry of the dotted "thinking orb" indicators
by Jakub Antalik, vendored from
<https://github.com/Jakubantalik/thinking-orbs> at commit
`de85557ca220332586d070d8788c0e1d6e877a0d` (package version 0.3.1, MIT).
The Swift port <https://github.com/haplollc/ThinkingOrbs> at commit
`e2c07bbdec4db797fb302300ef0159b1806a909f` (MIT, Copyright (c) 2026 Haplo LLC)
was consulted as a design reference only; none of its source is included.

Only the geometry is vendored: `MODE_FRAMES`, `resolvePreset` and the tuned
presets they need. The upstream React component, theme hooks and canvas
painters (`paint`, `paintLines`, `paintFrame`, `MODE_DRAWS`, `ModeDraw`) are
not included; Inertia paints the frames itself in
`src/renderer/src/components/working-indicator/orbPaint.ts`.

Changes against upstream:

- Every comment was removed. A token-level comparison with `@babel/parser`
  confirmed that stripping changed no code token in any file.
- Files were flattened into one directory. Import paths changed accordingly,
  and `index.ts` is a small local barrel.
- `states.ts` keeps only the `OrbState` and `OrbSize` types from upstream
  `src/types.ts`; the React prop types were dropped.
- The canvas painters listed above were removed from `core.ts`, `registry.ts`
  and `types.ts`.

No numeric constant, expression or control flow was changed.
`tests/renderer/thinking-orbs-engine.test.ts` checks the engine against a
deterministic subset of upstream `spec/orbs-golden.json` (SHA-256
`70bfaa2bbf1390b63f6ec02f16d7a4329fee67b3b290e671fe1d205328165e20`): all nine
designs at both tuned sizes and two instants, with every resolved preset,
within 1e-6. The subset lives in
`tests/fixtures/thinking-orbs/golden-subset.json`.

| Local file | Upstream file | Upstream SHA-256 | Local SHA-256 |
| --- | --- | --- | --- |
| `braid.ts` | `src/engine/braid.ts` | `a0d09442a9162dfa2f16fafb8dc435b88edb0bc9e7011ea6bc558be586ae938b` | `51cedc5b4fd7504b82a5a3f795c7fb30b00fe5fb5b65cfce0ee6e9548e5afe20` |
| `core.ts` | `src/engine/core.ts` | `7776ef7bbd57c0f3f862126b9247669d11e9df5233d76573bc0b2b0da38ba6db` | `aa0c047a6df5ae9d7b4988853b9c0ec9663eda56d22e270f5712969640bea958` |
| `lattice.ts` | `src/engine/lattice.ts` | `785e03ee9dc7ddc955952f666c8b269351571dffc96fb0ddc4050e5718444397` | `5e0b511f046b15c8229a9a955a7b69573e00975167d0af201e69c8fb478f4657` |
| `morph.ts` | `src/engine/morph.ts` | `6ae227001dec4f9254b55ae517d15e6eae4bf64699364e3032b628912ad05d43` | `5bfe6f3ed323d1537cf2a53557d6599a89d8b613173f6a9f8cfcad130a414b29` |
| `orbits.ts` | `src/engine/orbits.ts` | `27f974f2d9e0e1614055882673217b4db230bf8e4b88dc5ac21b298a924dfb65` | `400f6346d83f414bdaf48c5c77a596732063e4bd1466ee0bebe60a407d328f01` |
| `presets.ts` | `src/presets.ts` | `b6263cbfbd232db1319e3a598bc1969ef12f0131eb877b583567ddc1661d19f1` | `b7d1bca41eb940652b7cde7949c3e8e80d7aeac555d1d03802f872198f07ca15` |
| `profiles.ts` | `src/engine/profiles.ts` | `e1a5ca49a5e6ac80b56d77073cb28f1ea36742bee7be3a13ccaba7d3731d360b` | `46c9c8ef2becb65f1ec6f6f19eb916e6cacc5c18496f1b2435b96d68ffc8cf8e` |
| `registry.ts` | `src/engine/registry.ts` | `fb36d8815f598e69535bb86af576260c375bf1dcf4d54c0d6a31e68f42a13c49` | `12a075c9c344b419fc88662ba7e9966d3ae95ac9a65cc6b0af6ca7e8a18fc4d3` |
| `ribbon.ts` | `src/engine/ribbon.ts` | `a79cc262b42f3f12f5d4a108e7cf9710938d5fb1f6166c9fa789f02d4e0679c4` | `13d21ab2fa5da35d70ce87444088aec71b721eaafc00e883e5b5316d432205c1` |
| `states.ts` | `src/types.ts` | `9e460312d5061e845f769dfd4ecafe0f3b5acf26178d405161b84e42245186ff` | `27a0ff52ccdac04dd320e964560ccb233d77b1d600583a8a30467698612c858b` |
| `types.ts` | `src/engine/types.ts` | `33dc880d34da6c68adf0d03e484f42f43e97783b764991f21b8a6e386c2d7972` | `d3a460f5d8075ef5c7df56d392a6e0487e4e212055c3445c19d87f7066063344` |
| `web.ts` | `src/engine/web.ts` | `1dc2e38e9d01298ebf32744a3569f4e3234ba4af61cc64c5089511f7a9b7369d` | `58db810670d396fd60f59a911be63ad4666c99dac40af589b3ba6feeb397360d` |

`LICENSE` is the upstream license file, unchanged (SHA-256
`915a283980628a0ca9e7b423ebafc6f3a0fa1e630ff17d34e59034808d92011c`). The distributable notice is kept in
`resources/thinking-orbs-notices.txt` and added to the packaged
`THIRD_PARTY_NOTICES.txt` by `scripts/generate-third-party-notices.mjs`.
