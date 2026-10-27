# Retrospective fixed-inventory identity validation

The before-source/hash and red test are preserved. A matched null inventory and
payload ID could previously authorize an otherwise valid job, and missing or
unhashable IDs could raise an exception before producing a qualification result.
This is a bounded public-input domain repair, not a broader expression change.

Inventory IDs now require a positive safe integer or a nonempty trimmed string.
Names require nonempty trimmed strings. The fixed inventory must carry matching
typed runId/runAttempt/headSha fields from a valid run header. Invalid inventory
or payload-ID schema returns OPEN/UNKNOWN/unauthorized before dictionary lookup.
Missing payload IDs therefore cannot erase the obligations of valid inventory.
Payload run-header comparison also uses exact types, preventing Python's True==1
equivalence from satisfying a numeric run identity.

Twenty-one test methods pass. Controls cover null/missing/empty/boolean/zero/
negative/oversized/structured IDs, missing names/run fields, a valid string ID,
and payload ID withdrawal. Unit fixtures now use positive IDs rather than their
earlier zero-based helper IDs; expected source slot IDs and semantics are intact.
Original held-out records are retained separately and are not overwritten.
