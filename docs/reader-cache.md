# Bounded record lookup and sorted navigation

The browser keeps a completed reader worker between list requests. Active
replacement, Stop, worker failure and unmount terminate it. The worker retains
positions and required key or sort values; visible records are read again.

All retained results bind the selected dataset, ordered member descriptors,
schema, publication identity and compatibility policy. Key maps and exact-query
answers also bind the declared identity; sorted results also bind filters,
order, connection values and navigation definitions. Descriptions and a declared
identity arriving with metadata therefore neither restart a list read nor
discard its sorted results. A cache hit checks every selected member through a
one-byte, `no-store`, conditional range request. The reader checks the strong
ETag, exact range, total size and returned byte length. This includes missing,
ambiguous and empty-page answers, and members outside the visible page. Every
subsequent detail range keeps the same checks. Declared-empty members also
require a matching empty Parquet footer.

Exact lookups build one complete key map for supported primitive identities
within 500,000 rows and an estimated 128 MiB. It covers composite keys and
multipart tables. Each distinct key is estimated at 256 bytes plus two bytes per
character of its canonical form (for example `["string:119-hr-1"]`), and a
second witness adds 8 bytes. The canonical form adds 11 characters per string
component, which leaves `congress_bills` (421,773 rows in the retained Oct 6
snapshot) about 3-6% headroom for 11-15 character IDs; a larger table falls
back to continuation. Components use the filter reader's exact typed equality,
in declared-column order. Null or unsupported components cannot fabricate a
matching key. Two witnessed positions represent ambiguity. A unique position
must independently match the original filters when its full record is read.

Larger populations and unsupported key types use the existing 250,000-row
continuation. A population whose key estimate exceeds the budget stops
projecting as soon as it does; the worker remembers that verdict for the table
binding, so later lookups go straight to continuation. One worker retains at
most 128 completed exact-query answers within an estimated 1 MiB for one table
binding. Completion comes from that worker's own checked continuation, never a
caller-supplied success claim. A first unseen key on a large table still
requires scanning; this implementation does not provide a published global key
index. Incomplete results are not memoized. Changing table bindings clears this
memo.

Sorted reads retain one complete matching sort population when the source has
at most 100,000 rows and the estimate stays within 32 MiB. Larger sources retain
up to eight requested pages, capped at 8,000 entries and the same byte estimate.
The existing page-sized heap runs alongside admission so oversized values can
fall back without losing results. A window is admitted only after the complete
scan and member-version renewal succeed. Its total remaining match count, rather
than the end of the window, determines whether paging is complete.

Consecutive covered pages avoid rescanning sort and filter fields. Exhausted
windows, changed queries, unsupported cursors and eviction require another scan.
A changed page size can reuse a window only if it contains enough entries or
the complete remainder. There is one retained sort population or window per
worker. Sorting unbound files keeps the original per-page scan behavior.

Sorted cursors retain their original meaning: one plus the last record's
physical position. The maintained comparator keeps missing values last in both
directions and breaks ties by physical position. A cursor for a filtered-out
record still uses that record's actual sort value as the boundary.

The focused tests are `bill-lookup-harness.test.mjs`,
`exact-record-lookup.test.mjs`, `fec-compatibility.test.mjs`,
`navigation-reader.test.mjs`, `reader-cache.test.mjs`, `reader.test.mjs` and
`worker-lifecycle.test.mjs` under `tests/`. Real Parquet fixtures exercise range
transport and multipart values. Constructed reader-adapter fixtures cover the
above-threshold algorithms and count decoded rows without corpus downloads.
Those constructed counts establish bounded algorithm behavior, not live latency
or a production performance rate.

There is one supported in-process locator representation: typed canonical
composite keys mapped to witnessed physical positions. The comparison harness
uses that representation directly. Earlier raw bill-key experiment files are
not inputs to it. The experimental sorted file is not a runtime publication
input. Bounded scans and heaps remain current-format algorithms for inputs
outside retention limits.
