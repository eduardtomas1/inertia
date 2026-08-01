# Durable data-path measurements

`npm run benchmark:data-throughput` compares the replaced persistence behavior
with the new bounded design. It is a reproducible engineering benchmark, not a
release gate: results depend on filesystem cache state and host load.

## 2026-08-01 baseline

Environment: macOS arm64, Node.js 22.23.2. PDF.js and native canvas modules were
warmed before measurement. SQLite used the application's WAL and
`synchronous = NORMAL` policy with automatic checkpoints disabled so write
amplification remained visible.

| Case | Mode | Wall | CPU | WAL writes | Peak RSS growth |
| --- | ---: | ---: | ---: | ---: | ---: |
| 512 × 512-byte streamed deltas | cumulative full-row copy | 88.5 ms | 88.1 ms | 69.62 MiB | 1.59 MiB |
| 512 × 512-byte streamed deltas | append chunks + terminal compaction | 10.2 ms | 10.2 ms | 7.19 MiB | 0.75 MiB |
| 8 × 32-page PDFs | eight concurrent extractions | 185.0 ms | 272.4 ms | — | 41.47 MiB |
| 8 × 32-page PDFs | two concurrent, 12 MiB shared input budget | 169.7 ms | 189.1 ms | — | 17.95 MiB |

For this run, chunk persistence reduced visible WAL amplification by 89.7% and
stream wall time by 88.5%. Bounded PDF scheduling reduced peak RSS growth by
56.7% without increasing elapsed time. The implementation caps each turn at
eight documents, 20 MiB aggregate input, 96 KiB extracted output, and a shared
12-second deadline; the process-wide scheduler admits at most two PDFs and
12 MiB of input at once, rejects a single over-budget extraction, propagates
cancellation, and rotates fairly between turns.

Remote relay byte measurements intentionally remain absent from this baseline.
Remote revisioning is a separate dependent change and must be measured only
after the authoritative remote protocol/state contracts are integrated.
