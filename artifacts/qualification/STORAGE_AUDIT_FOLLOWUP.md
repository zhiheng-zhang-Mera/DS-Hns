# Storage audit follow-up: 2026-09-23

FQ-STORAGE-002 is a real qualification defect, not a passing historical audit.

- A direct focused instance test invocation on 2026-09-22 at 21:09:53 UTC inherited the caller's Windows TEMP and created nine `dshns-instance-*` directories on C. The invocation, not a production launch, omitted the qualification environment wrapper.
- The existing post-test name predicate recognized `dsh`, `ds-hns`, `ds-harness`, and `hns`, but missed `dshns`. A later run's start-time filter also cannot certify absence of earlier writes.
- The real historical audit now fails with those nine paths. Raw report: `D:\Hns-Final-Qualification\storage-audit-historical-failure.json`.
- Those exact nine directories were moved, not deleted, to `D:\Hns-Final-Qualification\preserved-c-drive-scratch-20260923`, preserving their original basenames. The earlier 00:58:47 UTC group was left untouched pending attribution. Remediation does not erase the historical violation.
- The audit recognizes `dshns` names. Direct instance tests use the existing repository-volume `resolveTestRoot` contract instead of ambient `os.tmpdir()`.
- Regression 1 observed the actual PowerShell predicate reject the instance name, then accept it after the change while rejecting unrelated names.
- Regression 2 ran the real instance suite in a child with a separate D-drive caller TEMP, observed nine misplaced directories before the fix, then no caller-TEMP writes and project-root scratch after the fix. No C-drive test fixture was created.
- Focused verification: 28 tests passed, zero failures. Complete unit regression: 1918 total, 1916 passed, zero failures, two repository-defined missing external community-sample skips. Raw log: `D:\Hns-Final-Qualification\storage-fix-full-unit.log`. Fresh candidate qualification remains required.

Run `2026-09-23T02-45-58-511Z-e5723a81` on `9e7404d` was deliberately interrupted during architecture verification before changing source. Its syntax and unit results are retained (1916 total, 1914 pass, 2 skips, zero failures); the run is NOT_COMPLETED and cannot certify the replacement candidate.

The cleanroom-4 install and visual observations remain evidence of `9e7404d`, not of the replacement candidate. No main merge or production tag is authorized by this follow-up alone.
