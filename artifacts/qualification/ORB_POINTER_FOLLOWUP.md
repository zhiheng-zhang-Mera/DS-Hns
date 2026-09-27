# Orb pointer regression, 2026-09-23

FQ-UI-005: cleanroom-6, candidate 9989ea7, default in-UI orb did not expand after real Codex pointer clicks. The optional system orb independently remained BLOCKED_NOT_RUN because Computer Use attributed its click point to the underlying Edge window, including one activation/fresh-screenshot retry. Those are different findings.

The in-UI orb marked every pointermove as a drag, even a stationary captured event. It also measured the delta from the ball's top-left rather than the pointer-down location. A behavioral regression reproduced `a 0px move swallowed the click` before repair. The bounded repair records the press location and requires 4 pixels before entering drag mode. Once dragging, it remains a drag even if the pointer returns to its start.

Focused tests: 25 passed, zero failures. Real construction-window verification used port 3098: a pointer click expanded the panel; a subsequent real Price click expanded its detail and countdown. Evidence: `D:\Hns-Final-Qualification\orb-fix-visual\01-click-expanded.png` and `02-price-feedback.png`. Raw RED/GREEN logs: `orb-pointer-regression-red.log` and `orb-pointer-regression-green.log` under the same task root. This diagnostic profile has only three of four optional/bundled dependencies; it is not the cleanroom install certificate.

Run `2026-09-23T03-13-25-232Z-fc733a28` on 9989ea7 was deliberately interrupted before source edits. It is NOT_COMPLETED, not PASS. Cleanroom-6 installation passed, but its visual run found this issue and no complete cleanroom qualification was started. Preserve its screenshots and failed observation as old-candidate evidence.

Complete unit regression passed: 1920 total, 1918 passed, zero failures, two repository-defined absent external community-sample skips (`D:\Hns-Final-Qualification\orb-fix-full-unit.log`). Replacement-candidate full qualification, a new remote cleanroom and final visual acceptance remain required. No production status is asserted here.
