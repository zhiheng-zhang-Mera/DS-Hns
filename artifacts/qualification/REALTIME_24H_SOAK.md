# Real wall-clock 24-hour soak

Status for qualified candidate `63eabc9a9341abd2e612bf603e3ce340eaa2cc57`: `NOT_RUN`.

No continuous 24-hour observation of the exact qualified candidate completed. The virtual-time synthetic soak is a separate gate and is not real wall-clock evidence.

A separate observer remains active for prior source-equivalent SHA `dafd3bfff8db30f2aaf094e4a15ed41a2c1f9ce6`; it is deliberately not stopped, but is not accepted for the current candidate. Its script filters processes under `D:\HnsQ24\repo`, while the observed runtime executable belongs to `D:\Hns-Cleanroom-Qualification-20\repo`; its SHA also differs from the qualified commit. The record therefore remains `NOT_RUN`, not `PASS` or a host-policy block.

The next valid run must first bind the exact candidate SHA and the observed process roots, then continuously sample live task/plugin state, memory, handles, event-loop drift, restart budget, CPU and file growth, and finish with orphan/process-storage audits.
