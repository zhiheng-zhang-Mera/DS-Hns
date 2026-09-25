# RC2 combined-acceptance CLI guard follow-up

**Result: `PASS_REGRESSION_AND_CLEAN_CI`.**

Commit `965ca619a2fa32d927af922e13103403e8cfe0a4` on `dev/hns-final-qualification-rc2` changes only `scripts/combined-acceptance.cjs` and adds `tests/unit/combined-acceptance-cli.test.js`; application source and package-manager configuration are unchanged.

The parser now handles `--help`/`-h` before git probes, fixture creation, phase execution, and report writes. Unknown options, missing option values, and invalid phase labels return exit code 2 with usage. The no-argument default remains the existing full A–E workflow. Help and invalid-option integration tests assert that no acceptance report or phase side effect is produced.

| Check | Result | Evidence |
|---|---|---|
| Local full unit suite, exact repository Node `v24.14.1` | 2,031 tests; 2,029 pass, 0 fail, 2 defined optional skips; 491,080 ms test duration | Run `2026-09-25T11-04-13-434Z-2f1e28d2`; summary `D:\qf\cli-guard-tests-20260925\qualification-runs\2026-09-25T11-04-13-434Z-2f1e28d2\qualification-summary.json` SHA-256 `6AE8464914A22B3AB97893A23203A2E593F7E69FFAECE69C66394303CC21455E`; artifact index SHA-256 `F0669194A611F763271B141BFF85F0D94178AE9C03D1AB35BE720F4DD3B99BFC` |
| Raw unit output | 2,029 pass / 0 fail / 2 skip | `D:\qf\cli-guard-tests-20260925\qualification-runs\2026-09-25T11-04-13-434Z-2f1e28d2\raw\all-unit-tests.stdout.txt`; SHA-256 `9A9ABC9695B5E8C5483AEC1E97C8DC52E2AADA6740EDB09B66961F564C9879A4` |
| Targeted CLI + Phase-C contract tests after commit | 4/4 pass; no skips | `node --check scripts/combined-acceptance.cjs` and `node --test tests/unit/combined-acceptance-cli.test.js tests/unit/combined-acceptance-contract.test.js`; D-rooted `TEMP/TMP` |
| Clean remote checkout CI at this commit | PASS, 3m48s | [GitHub Actions run 36128669905](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/36128669905), head SHA `965ca619a2fa32d927af922e13103403e8cfe0a4` |

The local full-suite qualification began before commit, with `--allow-dirty`, at parent HEAD `7918812302e6173f7377f0575394d842526f0aa3`; the summary binds that HEAD/tree, not the dirty patch. The tested implementation and test file were subsequently committed with SHA-256 `ED326B8CA96735E5A282568C25243F49AEC545A04A24EEB4A2F122998C111DA5` and `2081AEA9DD5F9A7AEDDD993038FCA029A2F7F50C47A8C67144F49FC1903EA3E3`, respectively, and the exact committed tree passed clean remote CI. Evidence consistency in the local D-rooted run passed 1/1.

This repair prevents a repeat of the unsupported-flag fall-through that caused `STORAGE-C-COMBINED-ACCEPTANCE-TEMP-001`; it does not erase that historical C-drive write. It also does not force `TEMP/TMP` onto D: for a valid full acceptance invocation, so qualification callers must continue to establish and verify D-rooted scratch before running phases.
