# Independently recomputing v37 cost tables

The cost analyzer is frozen separately in COST_FREEZE.json before formal timing.
It imports no benchmark or observer implementation and needs only Python's
standard library. From an exported artifact root:

```
python scripts/ecq/analyze_costs.py --root artifacts/paper-revision/ecq-v37 --out artifacts/paper-revision/ecq-v37/cost-analysis --verify-existing
```

Omit `--verify-existing` to write the JSON/CSV tables instead. The verification
flag compares deterministic serialized bytes against both published tables.
Source measurement paths and SHA-256 hashes are relative to the study root.

Complete formal-round groups produce median and linearly interpolated quartiles.
Budget-censored/partial configurations retain completed formal/warmup counts
but have no complete 30-round estimate. The separate native cost driver archives
warmups.jsonl; these records are counted and checked against the declared five
rounds. For older inputs without individual warmup records the observed count
is unavailable rather than inferred from the declaration. B2 retains its
completed warmup and partial formal attempts. Cold startup is separate.
Peak RSS is the worker's cumulative high-water mark, not per-stage allocation.
The measurements describe this host/OS and separately ordered runtimes.
