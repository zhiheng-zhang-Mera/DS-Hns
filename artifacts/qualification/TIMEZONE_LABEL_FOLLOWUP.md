# Scheduling timezone distinction

FQ-UI-003: cleanroom 7 real screenshot/click inspection showed `时区 Asia/Shanghai` beside a datetime-local input displaying Sydney local time. The schedule API's zone describes model billing windows; `instantFromLocal` and `localFromInstant` correctly use the browser's local timezone. The generic label incorrectly implied the input used the billing timezone.

The surgical repair labels the input `发送时间（本机时间） / Send at (local time)` and the billing zone `计费时区`. Both the header dialog and the orb form use the distinction. No parsing, timing, API, or task submission behavior changed.

Rendered-component regressions failed before the repair, then all 25 client tests passed. Raw logs: D:\Hns-Final-Qualification\timezone-label-red.log and timezone-billing-label-red.log / timezone-billing-label-green.log. The first draft's electricity-price wording was rejected in review and replaced with model billing terminology. Its interrupted full regression is preserved as timezone-label-full-unit.log, not counted as PASS. Final full regression uses timezone-billing-full-unit.log.

Full unit regression completed with exit 0: 1920 tests, 1918 pass, 0 fail, 2 repository-defined absent-community-sample skips (timezone-billing-full-unit.log). This precommit regression used compatible PATH Node v24.19.0; immutable final qualification uses the repository's portable Node v24.14.1.

The previous candidate's run 2026-09-23T03-38-06-453Z-a18694e6 was interrupted before editing and remains NOT_COMPLETED. Original cleanroom screenshots remain under D:\Hns-Cleanroom-Qualification-7\visual-evidence. Current-candidate full gates and a new fresh cleanroom must still pass; focused regression is not final qualification.
