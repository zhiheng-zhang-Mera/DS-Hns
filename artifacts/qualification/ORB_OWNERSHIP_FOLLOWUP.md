# FQ-ORB-OWNERSHIP-001: ownership lost at governance boundary

Candidate `997345fc8d0b7e219bfd6697ce9914427e0dd8e9` passed two full machine
qualifications and three extra combined repeats, but its fresh14 actual desktop
Journey exposed simultaneous native System Orb and in-UI ball surfaces.
At 2026-09-23T11:16:31.8902940Z governance omitted `orb` and the view reported
`mode: in-ui, hideInUi: false`. The native ball was visible in its own window.

Desktop's controlCenter caller already supplies native ownership. The
buildControlCenter boundary neither accepted nor returned that field. The
surgical repair forwards this existing field; it changes no window input,
layout, scheduling, permissions or lifecycle policy.

A real builder -> JSON serialization -> real view test first failed with
actual in-ui versus expected system. Focused regression passed 56/56 after
repair. Full declared npm test: 1946 tests, 1944 pass, zero fail, two existing
absent-external-sample skips; 446018.6825ms. These are construction regression
results, not repaired native visual acceptance or immutable-candidate gates.

Historical evidence lives under
`history/997345fc8d0b7e219bfd6697ce9914427e0dd8e9/orb-ownership-20260923/`.
The original complete evidence remains at
`D:/Hns-Cleanroom-Qualification-14/visual-journey-997345f`.
Raw RED/GREEN logs remain under D:/Hns-Final-Qualification/orb-ownership-*.log.

The separate native click attempt was rejected by the input tool's window
target guard (Explorer FolderView beneath a mouse-transparent ball). Its
product cause is unproven. No guard was bypassed; native interaction remains
NOT_RUN/input blocked. Startup disclaimer overlap and notification delivery
also remain unresolved. No real 24h interval has begun. Earlier machine PASS
does not override these findings or certify this repair. Author review only;
no independent QA or second agent was used.
