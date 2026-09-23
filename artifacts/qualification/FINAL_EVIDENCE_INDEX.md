# Final evidence index

The machine-readable index is [`FINAL_EVIDENCE_INDEX.json`](FINAL_EVIDENCE_INDEX.json). Exact commit identity is intentionally resolved from the immutable `qualification-summary.json` files rather than embedded as a self-referential Git hash in this tracked report.

The release evidence set consists of:

- the latest passing construction qualification whose `gitSha` equals the final candidate;
- a passing qualification from `D:\Hns-Cleanroom-Qualification-5\repo`, freshly cloned from the remote candidate branch (planned location; existence and PASS must be verified from its immutable summary);
- the three committed Phase C repeats and aggregate;
- real-input visual/UI evidence, with cleanroom visual observations kept distinct;
- explicit `NOT_RUN` records for the real Windows reboot and real 24-hour wall-clock soak;
- the evidence-linked paper-material corpus.

No result from another `runId` may be copied into a final summary. Synthetic, mock, stand-in, isolated rerun, and real-machine observations retain their original labels.
