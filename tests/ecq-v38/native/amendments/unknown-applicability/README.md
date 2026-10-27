# Retrospective unknown-applicability correction

This amendment was requested after initial evaluation, not before that freeze.
Initial evaluation artifacts are not overwritten. The pre-change native source
bytes and SHA-256 inventory are retained in this directory.

Two added unit controls failed before the one-line correction:

- `observed success under unknown applicability cannot establish needs result`:
  actual result `success`, expected `{"$unknown":true}`.
- `observed failure under unknown guard contributes only unknown gate`:
  actual result `failure`, expected `{"$unknown":true}`.

The correction retains captured record/metadata/coverage checks, but forces a
group's generated needs result to UNKNOWN whenever its applicability is UNKNOWN.
An independent known active failure still contributes UNSAT; raw observations
under an unknown guard cannot resolve ancestor applicability.

Post-change full unit output is `post-verification.txt`: 37 tests passed.
No independent-reference semantics or initial evaluation data were modified.
