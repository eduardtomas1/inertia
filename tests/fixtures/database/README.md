# Published database fixtures

These SQLite files are generated from the migration arrays at the exact
`v0.0.1` through `v0.0.6` Git tags. Each contains only fixed synthetic IDs,
`fixture://` workspace locations, sanitized text, and deterministic timestamps.
The v0.0.5 and v0.0.6 files remain separate even though those releases published
the same schema version.

Regenerate after intentionally changing fixture history extraction:

```sh
node scripts/generate-database-fixtures.mjs
```

Verify byte-for-byte reproducibility and tag provenance:

```sh
node scripts/generate-database-fixtures.mjs --verify
```
