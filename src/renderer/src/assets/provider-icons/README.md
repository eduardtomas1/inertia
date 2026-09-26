# Provider icon provenance

These local vectors identify the provider that owns a Work item. Their official
geometry and supplied colors are preserved; Inertia only scales them and swaps
vendor-provided light/dark variants where available. All marks remain the
property of their respective owners.

- `openai.svg`: OpenAI symbol from `openai/openai-assistants-quickstart` at
  commit `06fc2d444a5d41b574082080f4c7b2e48156b84f`, file
  `public/openai.svg` (MIT repository license). OpenAI's current mark terms and
  display guidance: <https://openai.com/brand/>.
- `anthropic.svg`: Anthropic/Claude mark from
  `anthropics/anthropic-sdk-typescript` at commit
  `ed02a89f5bad120c3191aa105820f33bfa14cef2`, file `.github/logo.svg` (MIT
  repository license). The supplied `#D97757` fill is unchanged.
- `cursor-light.svg` and `cursor-dark.svg`: the 2D cube light/dark SVGs from
  Cursor's official brand kit downloaded from <https://cursor.com/brand> on
  2026-08-11. The downloaded archive SHA-256 is
  `97488a7751914e60f9ff532bc33810cdeaebdddc017548abe6ca2bc29bbc3928`.
- `opencode-light.svg` and `opencode-dark.svg`: OpenCode identity marks from
  `anomalyco/opencode` at commit
  `9fdd4824d3c1e1c533a72359dd6c5f285ae9fc63`, files
  `packages/identity/mark-light.svg` and `packages/identity/mark.svg` (MIT
  repository license).
- `kimi.svg`: Kimi's mark from `agentclientprotocol/registry` at commit
  `bb1b44abe4f035ff75f4adfba18537b5470bd000`, file `kimi/icon.svg`, included
  with the Moonshot-contributed Kimi agent entry in
  <https://github.com/agentclientprotocol/registry/pull/28> (Apache-2.0
  repository license). The SVG bytes are unchanged; local SHA-256
  `e3354675d761f2b27651dce3afda0fcf7351c174bc19ecffe6c907b7121165d5`.
  The 24×24 monochrome geometry scales through the shared provider icon
  component and inverts in dark themes. The mark belongs to Moonshot AI and
  identifies Kimi without implying affiliation or endorsement.
- `antigravity.svg`: the Google Antigravity mark from
  `agentclientprotocol/registry` at commit
  `a3d294f480dee2e506a1c51f802455d4d49783a2`, file `antigravity-acp/icon.svg`.
  It was contributed with Google's official Antigravity registry entry in PR
  #542 by a Google engineer, as the icon ACP clients display to identify the
  agent. The registry is licensed Apache-2.0; the Antigravity entry itself
  declares a proprietary license with terms at <https://antigravity.google/terms>.
  Local SHA-256
  `ef068db27db956dbf947b59a3e6d21e8aa170656c55ff04d0b66fa673ea852c1`. The
  16×16 single-color `currentColor` glyph is unmodified; like the other
  monochrome marks, Inertia inverts it in dark themes. The mark belongs to
  Google LLC and is used only to identify the provider, without implying any
  affiliation or endorsement.

These assets are emitted into the packaged renderer for offline use; the
application does not request vendor-hosted images at runtime. The imports use
Vite's `?no-inline` form so the marks do not consume the entry JavaScript
budget. Their distributable license and trademark notices are maintained in
`resources/provider-icon-notices.txt` and appended to the packaged
`THIRD_PARTY_NOTICES.txt` during the existing notice-generation step.
