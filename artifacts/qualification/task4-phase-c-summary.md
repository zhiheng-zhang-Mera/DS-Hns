# Phase C stabilization evidence

Status: `PASS` at the unchanged `>= 1.2x` threshold.

The historical 1.189x miss came from five redundant Node validation process starts on the optimized path. The patch keeps the same six explicit test files and the same acceptance semantics, but submits that validation wave through one batched Node invocation. Phase B remains unbatched because it measures independent scheduler lanes.

| Run | Baseline | Optimized | Improvement | Process starts |
| --- | ---: | ---: | ---: | ---: |
| 1 | 17198 ms | 9141 ms | 1.881x | 7 -> 2 |
| 2 | 17218 ms | 9184 ms | 1.875x | 7 -> 2 |
| 3 | 17381 ms | 9248 ms | 1.879x | 7 -> 2 |

Aggregate improvement: min 1.875x, median 1.879x, max 1.881x, population variance 0.0000062222. Workload and threshold were not changed.
