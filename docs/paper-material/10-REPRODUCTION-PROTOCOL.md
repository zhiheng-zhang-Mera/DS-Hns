# Reproduction protocol

1. Use a fresh Windows checkout on an NTFS D-drive root; do not reuse `node_modules`, profile, cache, or runtime data.
2. Checkout the exact qualified SHA and verify `git rev-parse HEAD` and `HEAD^{tree}`.
3. Use the Node/npm versions installed by the repository bootstrap. External qualification fixtures use their own declared lockfiles: npm for `dsh-restart` and wallpaper, pnpm 11.24.0 for `dsh-web`.
4. Set `DSH_TEST_ROOT`, `DSH_TEMP_ROOT`, `DSH_RUNTIME_ROOT`, `TEMP`, `TMP`, `LOCALAPPDATA`, and `APPDATA` to run-local D paths.
5. Run `node scripts/qualification-runner.cjs --out-root <D:\evidence-root>` from a clean tracked tree.
6. Preserve the whole generated run directory. Verify `qualification-summary.json`, `reports/evidence-consistency.json`, raw stdout/stderr, and `artifact-index.json`.
7. Confirm mandatory failures are zero and post-test process/C-drive gates pass.
8. Repeat from a second fresh clone for clean-room evidence. Do not copy live artifacts into it.

Real reboot and real 24h protocols are separate enhanced experiments. If host policy does not permit them, record `NOT_RUN`; do not replace them with process kill or virtual time.
