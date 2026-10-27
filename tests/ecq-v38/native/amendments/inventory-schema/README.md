# Retrospective input identity schema repair

The pre-change source bytes/hash inventory and red unit output are retained here.
Original evaluation artifacts and earlier amendment records are unchanged.

Before repair, an inventory item and payload both carrying null/missing IDs could
bind each other through Map lookup and authorize. A null runId could similarly
match across untyped headers. The added linear inventory-schema obligation requires
own ID/name/run fields, valid positive-safe-integer or nonempty-string IDs, nonempty
names, positive-safe-integer attempts and nonempty head identities, matching the
typed root run header. The existing root runIdentity check now validates those
types too. Valid numeric/string IDs remain supported; erasing a payload ID against
a fixed valid inventory still blocks closure.

Full native post-repair verification output and source hashes are saved here.
