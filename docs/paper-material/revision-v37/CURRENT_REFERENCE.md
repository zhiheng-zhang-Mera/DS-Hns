# Current independent reference: source amendment v3

Use `scripts/ecq/corpus/reference_labels_v3.py` for new reference judgments.
Its source version constant is `independent-reference-v3`; its source SHA-256
and exact registered-label comparison are recorded in
`REFERENCE_V3_AMENDMENT.json`. The frozen predecessor `reference_labels.py`
remains byte-unchanged for the published V1/V2 provenance.

```
python scripts/ecq/corpus/reference_labels_v3.py --cases PATH/manifest.jsonl --out PATH/labels.jsonl
```

## Semantic correction and scope

The original reference reduced an empty collection of state comparisons to
ESTABLISHED. An empty statePolicy supplies no qualification identity requirement;
the native observer and SHACL profile instead return UNRESOLVED for this
relation. The amended reference treats an empty policy as UNRESOLVED as well.
Known state mismatches still dominate other missing state facts; a fully
supported FAIL remains CLOSED with UNSATISFIED gates and no authorization.

The empty-policy regression first failed against the uncorrected copied source,
then passed after the v3-only correction. `test_reference_v3.py` includes four
explicit controls; the original frozen source and its files were not rewritten.
Additional cross-implementation hand controls are logged separately in
`REFERENCE_V3_HAND_CONTROLS.json`; they do not enter research-case denominators.

Every registered package has a nonempty statePolicy. Independent v3 rederivation
confirmed exact serialized-label byte equality for all 300 development, 900
controlled evaluation, 240 external evaluation and 3 historical cases: 1,443 in
total. All axes, relation instances, statuses, logical witnesses and reason codes
are unchanged. No registered label was replaced and no measured method output
needed rejudging. Formal observers, frozen contracts and corpus inputs remain
unchanged.

## Identity convention

The legacy `oracleIdentity: independent-reference-v1` result tag is intentionally
retained so archived labels remain byte-identical. That tag identifies the
existing serialized label/profile convention; it is not the amended source's
identity. For current source attribution use the v3 path, source version and
SHA-256 in the amendment report and the final immutable repository commit.
The source amendment is disclosed explicitly rather than silently changing a
historically frozen implementation or asserting a new unseen holdout.
