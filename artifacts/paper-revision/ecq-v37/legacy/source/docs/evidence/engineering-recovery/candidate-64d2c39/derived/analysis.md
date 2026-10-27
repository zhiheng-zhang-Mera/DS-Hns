# Recovery evidence analysis — E2-E5-final-20260927-02

Phase: FINAL; seed: 20260928; runs: 21.
Classifications: PASS 12, EXPECTED_BLOCK 9, FAIL 0, INVALID 0.
Fault coverage: 9/89 final observations; 80 NOT_RUN.
Status: HNS_INTEGRATION_RC_NOT_READY.

- A1: PASS — the E0 gate is checksummed and matches the exact tested branch and implementation SHA
- A2: PASS — all applicable observed safety oracles passed with no invalid or failing run
- A3: PASS — every executable safe fault ID has an accepted E2 observation and every other catalog row carries an explicit scope/maintenance reason
- A4: NOT_RUN — E3 eight-scenario × ten-seed × W1/W2/W3 robustness matrix was not run
- A5: PASS — E5 recorded 20 accepted W2 observations covering fault IDs 80–87; O7/O8 cleanup evidence and D:-work/C:-scratch identities were verified
- A6: NOT_RUN — E6 real reboot repetitions were not run; no separately confirmed safe maintenance window was supplied
- A7: PASS — raw runs and derived IDs verified; checksum manifest covers freeze, E0, raw-run checksum files and analysis tables
- A8: PASS — the report separates simulated/real process/reboot evidence, records NOT_RUN reasons, and limits claims to exercised configurations

All tables derive from checksummed raw runs. Missing observations retain explicit NOT_RUN reasons; pilot data remains excluded from final aggregates.
