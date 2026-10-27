# Falsified review hypothesis; no implementation correction

The preserved red test hypothesized that a missing property of a known-complete
expression context must be the literal empty string rather than null. Owned
GitHub Actions run 40490589156 falsified that hypothesis: its expressions.json
reports missingJSON null and missingStringZero/missingStringEmpty/missingNull/
missingFalse all true. The literal empty string compared with string "0" is
false, so substituting the string for the observed null value would introduce
an incorrect semantic change. A separate matrix-specific run 40490954765 then
confirmed missingJSON null, missingStringZero true, literalEmptyStringZero false,
and rendered empty text. Its observe(1) job retained raw FAILURE while the
workflow succeeded under the matching tolerance policy. The hypothesis is fully
withdrawn; no implementation source change was made for missing/null semantics.

Root probe evidence: D:/temp/ecq-v38-missing-probe (actual platform outputs).
The pre-hypothesis source snapshot, hash and failing test output are retained
for provenance. The implementation lookup semantics were not changed. The
regression expectations were revised to the observed platform behavior rather
than treating the initial review hypothesis as ground truth. Matrix evidence is
retained at D:/temp/ecq-v38-matrix-missing-probe.
