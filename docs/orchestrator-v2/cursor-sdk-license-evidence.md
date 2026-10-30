# Cursor SDK 1.0.38 license provenance evidence

Investigated 2026-10-30 against checkout HEAD `e6189b9b7be91b0aad4f917c81f38c425985e8e5`. Read-only artifact investigation for [PR #686](https://github.com/eduardtomas1/inertia/pull/686).

**Recommendation: keep packaged SDK availability blocked pending authoritative upstream material.** One component has a defensible supplemental source: the Linux x64 ripgrep binary exactly matches an official Anysphere release archive containing license files. This does not resolve the missing platform `LICENSE.md`, tree-sitter native bindings, sandbox helper, or completeness of bundled-component notices. No recovered artifact supports applying the root Cursor terms to those components.

## Evidence standard and method

Exact = downloaded publisher artifact with verified digest and byte comparison. Partial = identifiable source/component without a proved complete mapping to the distributed binary. Unresolved = no sufficient mapping or notice material found in the sources inspected; this is not a claim that no such material exists anywhere.

Inspected AGENTS.md, provider-integration-seams.md, installed manifests/files, package-lock.json and the notice generator. Downloaded only exact-version artifacts to `/tmp/cursor-sdk-license-evidence.As0WWY`; inventories and metadata remain there. No dependency installation, bundled-binary execution, package/build/test commands, commits, upstream contact or CI monitoring. Only this new repository document was written. Hashes below are SHA-256 of raw bytes, not the generator’s newline-normalized text hashes.

## Exact npm distributions

For each package, downloaded `/@cursor/<name>/1.0.38` from registry.npmjs.org, followed its `dist.tarball`, and verified SHA-512 against **both** registry `dist.integrity` and the checkout lockfile; also verified registry SHA-1. Every regular archive file for installed `sdk` and `sdk-linux-x64` matched its installed counterpart byte-for-byte. Metadata supplied no `gitHead` or `dist.attestations` field. This proves registry/lockfile identity, not a source-build attestation.

| Package (all 1.0.38; links are exact tarballs) | Archive SHA-256 | License/notice filenames |
| --- | --- | --- |
| [@cursor/sdk](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.38.tgz) | `373d0c099c5b739cd7d09a2667f4eb26dd01c3ec85b833c8fba9314e923a75f5` | Root LICENSE.md and four dist LICENSE.txt files |
| [@cursor/sdk-linux-x64](https://registry.npmjs.org/@cursor/sdk-linux-x64/-/sdk-linux-x64-1.0.38.tgz) | `4316c83387ecb4cd94b7d45fd7a593aff1aadbee9345ba5f4b596c9ce45f9176` | None |
| [@cursor/sdk-linux-arm64](https://registry.npmjs.org/@cursor/sdk-linux-arm64/-/sdk-linux-arm64-1.0.38.tgz) | `f1dd7b83ff2eef7e77a2296c0a1d317814c6e8db222759264ab5e72503821b99` | None |
| [@cursor/sdk-darwin-arm64](https://registry.npmjs.org/@cursor/sdk-darwin-arm64/-/sdk-darwin-arm64-1.0.38.tgz) | `b849374fc4879203ddd0339eb2ba12c86b9797f6b075b1a2f3b385fd19b56b3e` | None |
| [@cursor/sdk-darwin-x64](https://registry.npmjs.org/@cursor/sdk-darwin-x64/-/sdk-darwin-x64-1.0.38.tgz) | `024191ff2f47eae388ce10523cab5e6f22f19c6c696574cd54001eafd3377860` | None |
| [@cursor/sdk-win32-x64](https://registry.npmjs.org/@cursor/sdk-win32-x64/-/sdk-win32-x64-1.0.38.tgz) | `b57167c70de2cf7f5b42ab98f4327bb36079089c0b180ea2bc3f3884c3650a89` | None |

The Linux platform manifest declares `SEE LICENSE IN LICENSE.md`; its `files` list names bin, vendor, package.json and README.md, omitting LICENSE.md. The **actual archive**, not just that list, has no license/notice files. All five platform archives share the omission. No other-platform license can be substituted.

Linux x64 complete regular-file inventory (paths relative to package root):

| File | SHA-256 |
| --- | --- |
| `bin/cursorsandbox` | `559ca202aef18b8459d63352ea0ebb10c8b2788c0207d01c19e242ae02f8f398` |
| `bin/rg` | `90a3b3eb75f41d9527a52517e884739ec65b9411dbb6a3cee24d1a58aa3470ae` |
| `vendor/tree-sitter-bash/index.js` | `242a9df49004d4f80a995e11abc807bc36f2d1411a9a5c69388e028cc3c9f68e` |
| `vendor/tree-sitter/index.js` | `9ef80f1ad26e58708e66acb25266d139f45669129e163ef7e776668b684d8dbe` |
| `vendor/tree-sitter-bash/node-types.json` | `39763582e682b132eb5349af6e1d7be78aed98decf808ffa6bcf92cfed4ac5dc` |
| `package.json` | `7a2f92de6e75bf03ed2513aa0a4b04fc0c3f517355cf9615528208ba8fdf8fd9` |
| `vendor/tree-sitter-bash/package.json` | `b6d766e0404c27efb3230271c47fab7e5406f1429d4cbc267d9de68eba9b9f52` |
| `vendor/tree-sitter/package.json` | `137f3c5518cb2e069de8d0c5a5ecdd4744da2eef4c0a246f3641678963e9bf20` |
| `README.md` | `a193a936f13600dadf71c87c7fe5eee127532746e2dd71ce7a7017dbd5640732` |
| `vendor/tree-sitter-bash/binding.node` | `d78e0146e53a200797d1fce8ec004f265d9605a0d184c3790b1a341d2e80cdb5` |
| `vendor/tree-sitter/binding.node` | `85851166c6c75c3f71c809b003ce8a77e6408c89b18e0c0c627127c8d6ff0dde` |

## First-party terms and generator obligations

The root `package/LICENSE.md` in the SDK tarball has SHA-256 `8d17330e28e36f8fef39ccc6facd4b7ddc2855313b679b394f0547dde44408c4`. It is an Anysphere reserved-rights notice referring to [Cursor Terms of Service](https://cursor.com/terms-of-service), not third-party license text. The live terms inspected say updated September 3, 2026; they are not a version-pinned redistribution grant for these platform artifacts. Packaging rights under those terms remain a separate review requirement; this investigation makes no legal clearance finding.

`scripts/generate-third-party-notices.mjs` walks the production npm tree, reads package-root license/copying/notice files and explicitly referenced files, requires regular contained readable nonempty files, and rejects inconsistent material for the same package identity. Its missing-file path predicts failure on platform LICENSE.md; the reported generator failure was not rerun. `prebuild` and `build:packaged` invoke it. AGENTS.md requires runtime dependency notices and packaging verification.

The generator does not recursively inventory arbitrary vendor directories or nested webpack notice fragments. Consequently, restoring one root file would not prove notice completeness. The SDK’s `dist/{cjs,esm}/250.js.LICENSE.txt` (SHA-256 `9147d44d83cc2ac8d2467b4587564cadc61ea5b26447dcfe7946e99209150493`) names ieee754/BSD-3-Clause; `704.js.LICENSE.txt` (`eee2ff09a857426f7b58e3a52bc5e48305cd5d9a0f6f747be2f04c6cb845f16e`) names is-extendable, re2js v1.2.2 and strip-bom-string/MIT. These are attribution fragments, not a complete platform inventory or full license collection. Preserve and assess them separately.

## Verified partial recovery: ripgrep only

Static strings in installed bin/rg include `14.1.1-cursor3d1e1c655dc`; this was a search lead, not identity proof. The [official Anysphere release](https://github.com/anysphere/ripgrep/releases/tag/14.1.1-cursor3) provides [this exact Linux x64 archive](https://github.com/anysphere/ripgrep/releases/download/14.1.1-cursor3/ripgrep-14.1.1-cursor3-x86_64-unknown-linux-musl.tar.gz). Its SHA-256 is `7cd3c075281e401a884ebdca3d088249125f7d23d968ddc363193730cb34b977`, matching the release API asset digest. Its `ripgrep-14.1.1-cursor3-x86_64-unknown-linux-musl/rg` hashes to `90a3b3eb75f41d9527a52517e884739ec65b9411dbb6a3cee24d1a58aa3470ae`, exactly the installed and npm-distributed binary.

The same archive directory contains these defensible supplemental artifacts:

| Path below archive root directory | SHA-256 |
| --- | --- |
| `COPYING` | `01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f` |
| `LICENSE-MIT` | `0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f` |
| `UNLICENSE` | `7e12e5df4bae12cb21581ba157ced20e1986a0508dd10d0e8a4ab9a4cf94e85c` |

COPYING identifies dual MIT/Unlicense terms. These files are tied to the actual binary, unlike vanilla upstream 14.1.1 licenses. They do not themselves enumerate all linked Rust, PCRE2 or runtime components; a complete dependency/build notice inventory is still needed. No equivalence was established for other-platform rg binaries.

## Other components and release archive cross-check

- **tree-sitter 0.21.1 — partial.** Installed manifest explicitly calls it the anysphere/node-tree-sitter fork. [Official fork branches](https://api.github.com/repos/anysphere/node-tree-sitter/branches?per_page=100) include `ecfed5a5a96c0597dfbbeaad3866b124a0ccba91` and `8194d9ebad3ca0e460983c04e6c59097909903e5`, both declaring 0.21.1. Their index.js hash is `b02e6b0581fe03ec9bf98f2a05ee64229fbe266e62909f9d7549dfb5009530ea`, different from the shipped wrapper. A text diff shows both a binding-loader rewrite and changed node property definitions. The [first branch’s LICENSE](https://raw.githubusercontent.com/anysphere/node-tree-sitter/ecfed5a5a96c0597dfbbeaad3866b124a0ccba91/LICENSE) is MIT, SHA-256 `d39420a108609f487bece31800015cccabdb531fee4d543d66595459b3812d9a`. Master `75a0eccfedc491e26843bd744bb6806f8a8bfff4` declares 0.25.1. Fork tags/releases API lists were empty. No exact source/build mapping for shipped binding.node or its embedded parser/dependencies was established; none of these licenses is accepted here as a complete supplement.
- **tree-sitter-bash 0.21.0 — partial.** [Official v0.21.0](https://github.com/tree-sitter/tree-sitter-bash/tree/f3f26f47a126797c011c311cec9d449d855c3eab) resolves to `f3f26f47a126797c011c311cec9d449d855c3eab`. Its src/node-types.json exactly matches the distributed JSON hash above. Its [LICENSE](https://raw.githubusercontent.com/tree-sitter/tree-sitter-bash/f3f26f47a126797c011c311cec9d449d855c3eab/LICENSE) has SHA-256 `49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559`. Matching grammar metadata does not establish the native binding’s complete source/build identity or incorporated notices.
- **cursorsandbox — unresolved.** The platform README identifies its role, but the inspected package supplies no component version, source revision, build provenance or notices. A filename and Cursor ownership context are insufficient to establish the rights/notices for all incorporated code.
- **Public SDK source/releases — unresolved.** The npm manifests point to [cursor/cursor](https://github.com/cursor/cursor); its releases and tags API lists were empty at inspection. [SDK documentation](https://cursor.com/docs/sdk/typescript) and [release notes](https://prod.cursor.com/docs/release-notes/sdk) did not provide an exact 1.0.38 platform notice archive. This is a bounded negative finding, not proof of universal absence.

**Python release cross-check (exact).** [PyPI 1.0.38 metadata](https://pypi.org/pypi/cursor-sdk/1.0.38/json) supplies the [Linux x64 wheel](https://files.pythonhosted.org/packages/dc/2c/a2090a49982d19b33d819e2501d12183c878b09198b9c43930f6b3a557b8/cursor_sdk-1.0.38-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl), SHA-256 `e79f76211e5b5384564c2c17a959ad643d5fe3d4b3dffa8e13483ab20ad0a664`, verified against PyPI. All eleven files under `cursor_sdk/_vendor/bridge/node_modules/@cursor/sdk-linux-x64/` match the npm files above. That subtree still has no license. `cursor_sdk-1.0.38.dist-info/LICENSE.md` and the embedded SDK LICENSE.md merely repeat the same Cursor root text/hash. Other wheel dependency licenses are not evidence of applicability to the platform components. The [source archive](https://files.pythonhosted.org/packages/3f/25/d3e9af2d84eefae854bfa8ace9a5768f53340babacf986f0f2e3776baab4/cursor_sdk-1.0.38.tar.gz), verified SHA-256 `14eb186f811747758236e98b46e2032f30f1efb248e9ad2e54473da658169dcc`, likewise supplies only the same root license at `cursor_sdk-1.0.38/LICENSE.md`. Other-platform wheels were not downloaded.

## Actionable disposition

Continue adapter development, but retain the packaged-SDK release/availability block. Do not treat a hidden UI toggle as sufficient if the blocked assets still ship. Do not copy the SDK root license into platform packages, waive generator failures, replace vendor identities with same-number upstream versions, or remove notices to make packaging pass.

A future narrowly reviewable ripgrep supplement can pin the exact archive URL, archive hash, binary hash, and three notice-file hashes above; retain original text and attribution with an explicit Linux x64/component-only mapping. That is a partial remediation, not authorization to unblock this dependency. No such implementation was made here.

Before lifting the block, obtain publisher material explicitly mapped to 1.0.38 platform archive/binary hashes: the referenced platform license and scope; exact tree-sitter fork/native binding and grammar source revisions plus incorporated dependency notices; sandbox provenance and notices; and a complete bundled dependency/license inventory, including rg linked dependencies and SDK JavaScript bundles. Verify each supported platform independently, then review first-party redistribution scope and integrate the evidence without weakening fail-closed checks. A corrected later release would require a separate explicit dependency review, not silent substitution.

Validation: archive integrity and file comparisons only; no focused tests or full verification gate run, as explicitly requested. No packaged execution or real provider behavior exercised.
