# Retrospective fixed frame schema validation

Pre-change source/hash inventory and red controls are preserved here, separately
from initial evaluation artifacts and earlier amendment records.

Unknown/null/misspelled claim scopes previously fell back to conformity. The new
metadata-schema closure obligation accepts only the omitted/default conformity
scope or exact workflow-conformity/test-execution strings. Present immutable
eventContextComplete flags must be Boolean; captureComplete/workflowCancelled
must be Boolean or explicit UNKNOWN. Invalid types cannot inherit JavaScript
truthiness to assert context completeness or cancellation. The actual expression
completeness flag now uses exact true; invalid cancellation values remain UNKNOWN.

This is frame input validation, not a new workflow language feature or a full
GitHub YAML schema validator. Gate outcomes remain independently reported; invalid
metadata blocks closure and authorization. Full post-change native tests: 54 passed.
