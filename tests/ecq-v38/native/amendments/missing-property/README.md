# Falsified review hypothesis: complete missing property

The saved `pre-red-verification.txt` records a proposed empty-string scalar
semantics hypothesis, not a confirmed implementation defect. It was falsified
by two owned GitHub Actions observations:

- Run 40490589156: missing scalar JSON null; missing equality to string zero true.
- Run 40490954765: matrix missing scalar JSON null; string-zero equality true;
  literal empty-string equality to string zero false; rendered missing value empty.
  The sole raw failed job was tolerated by the missing/string-zero guard.

The existing null scalar semantics were retained without a core code change.
`missing-property.test.mjs` now encodes these observed distinctions and retains
literal-null and partial-UNKNOWN controls. The original red output remains here
to preserve the withdrawn hypothesis and its audit trail.
