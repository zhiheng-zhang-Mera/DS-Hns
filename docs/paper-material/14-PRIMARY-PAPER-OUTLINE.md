# Primary paper outline

Provisional title candidates:

- *Capability-Separated Recovery for a Long-Running AI Harness*
- *Keeping an AI Harness Honest Across Plugin and Runtime Failures*
- *Bounded Recovery and Task Continuity in an Extensible Desktop AI Harness*

1. **Problem:** interactive AI harnesses combine UI, plugins, long tasks, and restart behavior; shared authority can create false success, loops, and loss of continuity.
2. **Research questions:** RQ1 authority separation; RQ2 heterogeneous isolation; RQ3 continuity under injected failures; RQ4 evidence integrity.
3. **Principles:** declared capability surface, bounded recovery, durable truth, fail-closed qualification.
4. **Architecture:** Runtime Host/UI client, manager/adapters, health scheduler, restart-control provider, continuity store.
5. **Implementation:** Windows/Electron/Node, named pipe, controlled bridge, JSONL managed process.
6. **Evaluation:** adapter/install gates, eight chaos cases, synthetic horizons, Phase C measurement, clean-room qualification.
7. **Failure analysis:** current N1–N40 catalog (original historical slice N1–N16), preserving unresolved follow-ups and distinguishing bounded repairs from new contributions.
8. **Threats/limitations:** one host, synthetic time, stand-in app, no real reboot/24h.
9. **Reproducibility:** pinned source fixtures and immutable evidence run.
10. **Conclusion claim:** the implementation demonstrates bounded behavior under the tested conditions; it does not establish superiority, novelty, or field reliability.
