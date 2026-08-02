# Durable data-path measurements

`npm run benchmark:data-throughput` compares the replaced persistence behavior
with the new bounded design. It is a reproducible engineering benchmark, not a
release gate: results depend on filesystem cache state and host load.

## 2026-08-02 baseline

Environment: macOS arm64, Node.js 22.23.2. PDF.js and native canvas modules were
warmed before measurement. SQLite used the application's WAL and
`synchronous = NORMAL` policy with automatic checkpoints disabled so write
amplification remained visible.

| Case | Mode | Wall | CPU | WAL writes | Peak RSS growth |
| --- | ---: | ---: | ---: | ---: | ---: |
| 512 × 512-byte streamed deltas | cumulative full-row copy | 87.3 ms | 87.1 ms | 69.62 MiB | 1.52 MiB |
| 512 × 512-byte streamed deltas | append chunks + terminal compaction | 10.2 ms | 10.2 ms | 7.19 MiB | 0.41 MiB |
| 8 × 32-page PDFs | eight concurrent extractions | 190.6 ms | 290.7 ms | — | 38.67 MiB |
| 8 × 32-page PDFs | two concurrent, 12 MiB shared input budget | 167.0 ms | 185.7 ms | — | 17.56 MiB |

For this run, chunk persistence reduced visible WAL amplification by 89.7% and
stream wall time by 88.3%. Bounded PDF scheduling reduced peak RSS growth by
54.6% while reducing elapsed time. The implementation caps each turn at
eight documents, 20 MiB aggregate input, 96 KiB extracted output, and a shared
12-second deadline; the process-wide scheduler admits at most two PDFs and
12 MiB of input at once, rejects a single over-budget extraction, propagates
cancellation, aborts sibling work after the first substantive document failure,
unlinks cancelled queued buffers immediately, and rotates fairly between turns.

Stream appends split a single oversized provider delta transactionally at the
1,048,576-Unicode-code-point row invariant before insert. Ordering is unchanged
across live projection, restart recovery, and terminal compaction.

PDF.js and its native canvas polyfills are initialized through one process-wide
promise. Cold initialization is bounded to 30 seconds, cancelled callers stop
waiting without starting a duplicate native load, failed initialization is
evicted for retry, and a successful load remains cached. The shared 12-second
extraction deadline begins after that one-time module initialization; the outer
120-second message-preparation deadline still bounds the complete operation.

Remote relay byte measurements intentionally remain absent from this baseline.
Remote revisioning is a separate dependent change and must be measured only
after the authoritative remote protocol/state contracts are integrated.
