# Real Windows reboot acceptance

Status: `REAL_REBOOT_NOT_RUN_BY_HOST_POLICY`

No real Windows reboot was performed. The interactive Codex qualification session has no guaranteed post-boot continuation or durable authority to resume after restarting the owner workstation. Process restart, Electron relaunch, chaos injection, and virtual-time tests are not substitutes and are not reported as a real reboot.

The executable next step is to run the reboot ceremony from a host-controlled persistent runner that can record the pre-reboot task/checkpoint, resume automatically after Windows startup, and verify exactly-once continuation.
