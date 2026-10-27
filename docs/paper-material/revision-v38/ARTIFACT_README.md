# ECQ v38 research artifact

This package contains the conditional CI compiler, independently authored Python reference/source checker, controlled cases, preserved public API responses, pinned workflow sources, platform observations, dependency packages and executed study outputs. It does not execute collected workflow commands or contact GitHub during offline reproduction. Node.js24.14.0 and Python3.14.3 runtime binaries must already be installed.

## Offline reproduction

From a freshly extracted artifact directory:

```
python reproduce.py --root .
python reproduce.py --root . --full-archives
```

The first command verifies MANIFEST.json, checks the exact raw-to-derived archive bindings, verifies owned platform provenance, installs the bundled exact YAML packages into artifact-local runtime directories without running install scripts or using network, runs native/Python tests and all45 unchanged control cases, and independently recomputes the8 cost-summary medians from240 measured rounds. The optional second command also re-extracts/checks all80development/160evaluation candidate sources into `.runtime/archive-replay`; it never overwrites original study outputs. It uses the final amended observer, so compare its gate diagnoses with the retrospective result, not the original first pass.

Original first-pass method:724d23032568ef3ba33b338ca7433560471de8bb. The blind evaluation's155/160 gate agreement, all160 valid source certificates and zero authorization disagreements are preserved under `artifacts/paper-revision/ecq-v38/evaluation-history/blind-724d230/`. The method source ZIP is an exact Git archive of that commit. A one-line native amendment prevents an UNKNOWN-applicability group's observed success from establishing a known needs result. Retrospective evaluation agrees on160/160gates; it is not a second blinded experiment. Source selection and reference semantics are unchanged. Documentation later makes the theorem's established-judgment persistence assumption explicit; soundness alone is insufficient.

All240third-party execution-source identities remain UNKNOWN; these are candidate-source extraction archives, not240qualified execution claims. The owned12-job run includes an explicit workflow revision witness and original CLOSED/SAT authorization. Both implementations check all4096payload subsets, retaining fixed inventory; all4095proper erasures block. A later native-only replay confirms identical axes after the amendment; the initial platform loop's concurrent source-change detection is retained, not relabeled as unchanged.

The45development cases have14positive/31rejecting labels and11closure/gate labels. The794enumerated erasure checks comprise749distinct base/input pairs, including45originals and704proper erasures.180source-certificate attacks are rejected. Windows/Linux replay repeats the same cases; counts are not pooled as independent samples. There are34complete zero-job source failures and one incomplete jobs response. Six source revisions cross the run-disjoint development/evaluation split.

## Files and trust

- `scripts/ecq-v38/native` and `reference`: independent checking predicates; schema conventions are shared.
- `scripts/ecq-v38/study`: frozen control generator, analysis, raw timing drivers.
- `scripts/ecq-v38/collection/verify.py`: complete raw response, selected run, exact-attempt jobs and decoded source binding checks.
- `artifacts/paper-revision/ecq-v38/source`: frozen240-run collection and1093responses.
- `platform`: owned conformance archives, exact source witness, original/retrospective subset results and scalar probes.
- `evaluation-history`, `development-history`, and amendment test folders: original failures and repair history.
- `cost`: raw rounds, stage definitions and host metadata. Timing is descriptive for one host; stage medians are separately computed and not additive.
- `dependencies`: yaml2.8.3tarball matching lockfile SHA-512 and ruamel.yaml0.18.16pure Python wheel.
- `licenses` and `THIRD_PARTY_NOTICES.md`: exact-commit upstream licenses/copyrights and Requests NOTICE files for every redistributed workflow source hash.

The repository MIT license covers authored code, not relicensing of upstream workflows or bundled dependencies. Their original license texts are preserved. Peer-paper PDFs are not included. No producer signatures, arbitrary step semantics, complete dynamic matrices or independent field-wide quality percentile are claimed. Capture completeness, event completeness, source assertions and claim scope are fixed trust-boundary inputs; changing them is not payload erasure.
