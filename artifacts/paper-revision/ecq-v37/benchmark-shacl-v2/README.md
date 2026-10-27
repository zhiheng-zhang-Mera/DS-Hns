# SHACL cost observations

Formal driver: `scripts/ecq/bench_shacl_cost.py`, frozen at `65ae0b25f75c9d3dc1e7de97b3a8c69b83917141`. Each configuration uses a separate persistent Python process, five target warmups and thirty target formal rounds. The fixed per-configuration budget is180seconds after worker readiness.

Two10-gate cells completed. The100-gate cells retain20 and19 formal rounds; the1,000-gate cells retainone warmup each and no formal rounds. Every completed measurement is in `*.all-attempts.jsonl`; censor receipts remain separate. Only complete30-round cells receive median/quartile estimates.

B2 ran after the Node batch, not interleaved in paired cross-runtime rounds. `normalize_ms` is JSON decoding; `rdf_and_digest_ms` records graph/digest preparation, `rule_ms` validates a prepared graph, and end-to-end cost repeats decoding, actual reads/hashes and qualification. Peak RSS is an OS cumulative worker high-water mark. Runtime comparisons are descriptive.

Generate fresh Node fixture directories before a new B2 cost run; archived inputs and the frozen factory reproduce their exact bytes. Use a new output directory to preserve original observations.
