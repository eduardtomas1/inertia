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
12-second deadline. The benchmark above measured the earlier 12 MiB input
budget. The decoder's scheduler admits at most two operations with
a 96 MiB estimated working-memory budget; raster jobs reserve enough of that
budget to run one at a time. These reservations do not impose a hard bound on
PDF.js content-stream expansion or native canvas allocations. The scheduler
rejects a single over-budget reservation, propagates
cancellation, aborts sibling work after the first substantive document failure,
unlinks cancelled queued buffers immediately, and rotates fairly between turns.

Stream appends split a single oversized provider delta transactionally at the
1,048,576-Unicode-code-point row invariant before insert. Ordering is unchanged
across live projection, restart recovery, and terminal compaction.

Desktop PDF preparation now runs in a separate, short-lived Electron utility.
Main admits one decoder and two pending batches, sends only bounded bytes and
display metadata, and passes an empty child environment. Each utility has a
256 MiB V8 old-space limit. This is not a hard bound on RSS, content-stream
expansion, or native canvas memory; host memory exhaustion remains a limitation.
Ordinary text and spreadsheet batches without a PDF continue through the local
preparer. The benchmark above predates process isolation and does not measure
its startup or IPC cost.

PDF.js and its native canvas polyfills initialize once per decoder, with a
30-second initialization limit and a subsequent 12-second extraction deadline.
Main bounds the whole decoder operation to 43 seconds, clamped to the caller's
remaining preparation deadline, then allows at most three seconds to observe
termination. A result is accepted only after a matching reply and native exit;
the runtime adopts generated JPEG bytes into private storage afterward.
Unconfirmed termination blocks further decoder admission and remains part of
runtime shutdown/recycle ownership. The outer 120-second message-preparation
deadline still bounds the complete operation.

Private Connect gateway byte measurements belong to the local HTTP/WebSocket
boundary and are covered by its bounded body and frame limits.
